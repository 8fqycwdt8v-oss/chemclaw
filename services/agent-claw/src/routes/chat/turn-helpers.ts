// Helpers shared between the streaming and non-streaming /api/chat paths.
//
// Pulled out of turn-orchestration.ts to keep that module focused on the
// two run paths. Each helper here is pure-ish: it depends only on its
// arguments + the logger inside FastifyRequest.

import type { FastifyRequest } from "fastify";
import type { Span } from "@opentelemetry/api";
import type { Config } from "../../config.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { SkillLoader } from "../../core/skills.js";
import type { Tool } from "../../tools/tool.js";
import { buildAgent } from "../../core/harness.js";
import { lifecycle } from "../../core/runtime.js";
import {
  startRootTurnSpan,
  recordLlmUsage,
  recordSpanError,
} from "../../observability/spans.js";
import {
  PaperclipBudgetError,
  USD_PER_TOKEN_ESTIMATE,
  type PaperclipClient,
  type ReservationHandle,
} from "../../core/paperclip-client.js";

export type ReserveResult =
  | { kind: "ok"; handle: ReservationHandle | null }
  | { kind: "refused"; retryAfterSeconds: number; reason: string };

/**
 * Reserve Paperclip budget for this turn. Returns either the handle (which
 * may be null if Paperclip is unconfigured) OR a "budget refused" signal
 * the caller MUST surface as HTTP 429 with Retry-After.
 *
 * The reserve shape mirrors the chained-harness loop in
 * core/chained-harness.ts; both call sites use identical estTokens / estUsd
 * defaults so the daily-USD cap applies uniformly.
 */
export async function reservePaperclipForTurn(
  req: FastifyRequest,
  client: PaperclipClient | undefined,
  user: string,
  sessionId: string | null,
): Promise<ReserveResult> {
  if (!client) return { kind: "ok", handle: null };
  try {
    const handle = await client.reserve({
      userEntraId: user,
      sessionId: sessionId ?? "stateless",
      estTokens: 12_000,
      estUsd: 0.05,
    });
    return { kind: "ok", handle };
  } catch (err: unknown) {
    if (err instanceof PaperclipBudgetError) {
      return {
        kind: "refused",
        retryAfterSeconds: err.retryAfterSeconds,
        reason: err.reason,
      };
    }
    req.log.warn({ err }, "paperclip /reserve failed (non-fatal)");
    return { kind: "ok", handle: null };
  }
}

/**
 * Best-effort Paperclip release for the non-streaming path. The streaming
 * path's release runs inside finalizeStreamingTurn (end-of-turn.ts) so the
 * release shape is centralised between the two paths.
 */
export async function releasePaperclipForNonStreaming(
  req: FastifyRequest,
  handle: ReservationHandle | null,
  promptTokens: number,
  completionTokens: number,
): Promise<void> {
  if (!handle) return;
  try {
    const totalTokens = promptTokens + completionTokens;
    const actualUsd = totalTokens * USD_PER_TOKEN_ESTIMATE;
    await handle.release(totalTokens, actualUsd);
  } catch (relErr) {
    req.log.warn({ err: relErr }, "paperclip /release failed (non-fatal)");
  }
}

/**
 * Close the OTel root span for the non-streaming path, recording final
 * LLM usage and any error. The streaming path closes its span inside
 * finalizeStreamingTurn instead.
 */
export function closeNonStreamingSpan(
  rootSpan: Span,
  agentModel: string,
  promptTokens: number,
  completionTokens: number,
): void {
  try {
    recordLlmUsage(rootSpan, {
      promptTokens,
      completionTokens,
      model: agentModel,
    });
  } catch (spanErr) {
    try { recordSpanError(rootSpan, spanErr); } catch { /* ignore */ }
  }
  try { rootSpan.end(); } catch { /* ignore */ }
}

/**
 * Open the OTel root span for this turn. Both paths inherit the same span
 * context — plan-mode / non-streaming completeJson calls inherit via
 * context.with() so LiteLLM's auto-instrumentation parents its trace
 * under the root.
 */
export function openRootSpan(opts: {
  agentTraceId: string | undefined;
  sessionId: string | null;
  user: string;
  agentModel: string;
  activePromptVersion: number | undefined;
}): Span {
  return startRootTurnSpan({
    traceId: opts.agentTraceId ?? opts.sessionId ?? "unknown",
    userEntraId: opts.user,
    model: opts.agentModel,
    promptName: "agent.system",
    promptVersion: opts.activePromptVersion,
    sessionId: opts.sessionId ?? undefined,
  });
}

export interface AgentBuildDeps {
  config: Config;
  llm: LlmProvider;
  registry: ToolRegistry;
  skillLoader?: SkillLoader;
}

/**
 * Build the agent (tools filtered by active skills, max-steps respecting
 * skill overrides). Shared by both run paths.
 */
export function buildAgentForTurn(deps: AgentBuildDeps): {
  agent: ReturnType<typeof buildAgent>;
  tools: Tool[];
  effectiveMaxSteps: number;
} {
  const allTools = deps.registry.all();
  const tools = deps.skillLoader ? deps.skillLoader.filterTools(allTools) : allTools;
  const skillMaxSteps = deps.skillLoader?.maxStepsOverride();
  const effectiveMaxSteps = skillMaxSteps ?? deps.config.AGENT_CHAT_MAX_STEPS;
  const agent = buildAgent({
    llm: deps.llm,
    tools,
    lifecycle,
    maxSteps: effectiveMaxSteps,
    maxPromptTokens: deps.config.AGENT_TOKEN_BUDGET,
  });
  return { agent, tools, effectiveMaxSteps };
}
