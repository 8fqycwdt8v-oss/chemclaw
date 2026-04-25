// Phase E — Shadow prompt evaluator.
//
// When loading the active prompt for a turn, we ALSO check for shadow prompts
// (prompt_registry rows with shadow_until > NOW() and active=FALSE).
// For a configurable fraction of traffic (AGENT_SHADOW_SAMPLE, default 0.1),
// the shadow prompt is evaluated in a non-streaming parallel call with the
// same user context. The result is scored and written to shadow_run_scores.
//
// This is entirely invisible to the user — the agent's actual response comes
// only from the active prompt.
//
// After 7 days, if the shadow score meets criteria, the skill_promoter
// (services/optimizer/skill_promoter/) flips active=TRUE on the shadow.

import type { Pool } from "pg";
import type { LlmProvider } from "../llm/provider.js";
import type { Message } from "../core/types.js";
import type { PromptRegistry } from "./registry.js";

// Re-export Message so consumers of ShadowEvalContext don't need to import from types.js.
export type { Message };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShadowEvalContext {
  promptName: string;
  messages: Message[];
  traceId: string | null;
  userEntraId: string;
}

export interface ShadowScoreResult {
  version: number;
  score: number;
  shadowResponse: string;
}

// ---------------------------------------------------------------------------
// Scoring heuristic
// ---------------------------------------------------------------------------

/**
 * Simple inline scorer — mirrors the citation-faithfulness + length components
 * of the GEPA metric but without the feedback signal (unavailable at eval time).
 *
 * Score breakdown:
 *   60% — response length normality (penalise very short / very long)
 *   40% — citation density (UUIDs per 500 chars)
 *
 * This is intentionally cheap; the real metric runs in the GEPA optimizer.
 */
function _scoreResponse(response: string): number {
  const len = response.length;
  // Length score: peak at 600 chars, decays toward 0 beyond 4000 and below 50.
  const lenScore = Math.max(0, 1 - Math.abs(len - 600) / 3000);

  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const citationCount = (response.match(uuidRe) ?? []).length;
  const citationDensity = Math.min(1, citationCount / Math.max(1, len / 500));

  return Math.round((0.6 * lenScore + 0.4 * citationDensity) * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// ShadowEvaluator
// ---------------------------------------------------------------------------

export class ShadowEvaluator {
  private readonly sampleRate: number;

  constructor(
    private readonly promptRegistry: PromptRegistry,
    private readonly llm: LlmProvider,
    private readonly pool: Pool,
    sampleRate: number = parseFloat(process.env["AGENT_SHADOW_SAMPLE"] ?? "0.1"),
  ) {
    this.sampleRate = Math.max(0, Math.min(1, sampleRate));
  }

  /**
   * Fire-and-forget shadow evaluation.
   * Called after the active response is returned to the user.
   * Never rejects — all errors are swallowed to avoid affecting the main path.
   */
  async evaluateAsync(ctx: ShadowEvalContext): Promise<void> {
    if (Math.random() > this.sampleRate) return;

    try {
      const shadows = await this.promptRegistry.getShadowPrompts(ctx.promptName);
      if (shadows.length === 0) return;

      await Promise.allSettled(
        shadows.map((shadow) => this._evalOne(shadow, ctx)),
      );
    } catch {
      // Silently swallow — shadow eval must never affect user responses.
    }
  }

  private async _evalOne(
    shadow: { template: string; version: number; shadowUntil: Date },
    ctx: ShadowEvalContext,
  ): Promise<void> {
    const systemMsg: Message = { role: "system" as const, content: shadow.template };
    const allMessages: Message[] = [systemMsg, ...ctx.messages];

    // Non-streaming call via completeJson (structured, no tools needed).
    // We just want the text — use completeJson with a minimal schema.
    const systemContent = shadow.template;
    const userContent = ctx.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");

    const responseObj = (await this.llm.completeJson({
      system: systemContent,
      user: userContent,
      role: "executor",
    })) as { text?: string; answer?: string } | string | null;

    const responseText: string =
      typeof responseObj === "string"
        ? responseObj
        : (responseObj as { text?: string; answer?: string } | null)?.text ??
          (responseObj as { text?: string; answer?: string } | null)?.answer ??
          "";

    const score = _scoreResponse(responseText);

    await this.promptRegistry.recordShadowScore(
      ctx.promptName,
      shadow.version,
      ctx.traceId,
      score,
      null,
    );
  }
}
