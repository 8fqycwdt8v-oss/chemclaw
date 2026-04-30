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

// UUID-shaped fact_id regex — must mirror services/optimizer/gepa_runner/
// metric.py:_FACT_ID_RE so shadow scoring and GEPA's citation-faithfulness
// component agree on what counts as a citation.
const FACT_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Composite shadow score — aligned with GEPA's citation-faithfulness signal
 * (deep-review #10).
 *
 * GEPA's full metric is `0.5*feedback + 0.3*golden + 0.2*citation_faithfulness`.
 * Shadow eval can't see user feedback (the response was never delivered) and
 * doesn't have golden examples in scope, so we use:
 *
 *   80% — citation faithfulness (every UUID in the response also appears in
 *         tool_outputs from the same turn). Mirrors the GEPA component
 *         exactly so a candidate that scores well in shadow scores well in
 *         GEPA's citation slice. When tool_outputs is empty AND the response
 *         has no UUIDs, this is trivially 1.0 (no claims = no faithfulness
 *         violations) — same convention as the GEPA metric.
 *   20% — response length normality (penalise truncated / runaway responses).
 *         A weak signal kept at low weight so a faithful but oddly-shaped
 *         response still scores reasonably.
 *
 * The shadow_promote/shadow_reject gate's 0.80 absolute floor is calibrated
 * to this metric's distribution, NOT to GEPA's full composite — the two are
 * intentionally different signals. Documented divergence: shadow eval is a
 * runtime-cheap gate that flags candidates worth further GEPA scrutiny;
 * GEPA's training-time score is the authoritative quality signal.
 */
function _scoreResponse(response: string, toolOutputs: unknown[]): number {
  // --- citation faithfulness (mirrors GEPA's _citation_faithfulness_score) ---
  const claimedRaw = response.match(FACT_ID_RE) ?? [];
  const claimed = new Set(claimedRaw.map((s) => s.toLowerCase()));
  let faithScore = 1.0;
  if (claimed.size > 0) {
    const available = new Set<string>();
    for (const out of toolOutputs) {
      try {
        const text = JSON.stringify(out).toLowerCase();
        for (const m of text.match(FACT_ID_RE) ?? []) {
          available.add(m);
        }
      } catch {
        // Non-serialisable output: skip.
      }
    }
    const faithful = [...claimed].filter((c) => available.has(c)).length;
    faithScore = faithful / claimed.size;
  }

  // --- length normality (peak at 600 chars, decays toward 0 beyond 4000 / below 50) ---
  const len = response.length;
  const lenScore = Math.max(0, 1 - Math.abs(len - 600) / 3000);

  return Math.round((0.8 * faithScore + 0.2 * lenScore) * 10000) / 10000;
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
    sampleRate: number = parseFloat(process.env.AGENT_SHADOW_SAMPLE ?? "0.1"),
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
    // _systemMsg / _allMessages are kept here as a placeholder for the
    // post-streaming variant (PR-1 paydown noted them as unused locals).
    const _systemMsg: Message = { role: "system" as const, content: shadow.template };
    const _allMessages: Message[] = [_systemMsg, ...ctx.messages];

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
        : (responseObj)?.text ??
          (responseObj)?.answer ??
          "";

    // Shadow runs without tool execution (see completeJson contract above —
    // it's a structured single-turn call, no tools registered for the
    // shadow LLM). That means no harvested fact IDs are available at
    // scoring time. Passing an empty array is the GEPA-compatible default:
    // when the response has no UUIDs, citation faithfulness scores 1.0
    // (no claims to violate); when the response cites a UUID, faithfulness
    // scores 0.0 (no source to ground against). This biases shadow toward
    // prompts that don't fabricate IDs without evidence — exactly what
    // we want for a runtime-cheap quality gate.
    const score = _scoreResponse(responseText, []);

    await this.promptRegistry.recordShadowScore(
      ctx.promptName,
      shadow.version,
      ctx.traceId,
      score,
      null,
    );
  }
}
