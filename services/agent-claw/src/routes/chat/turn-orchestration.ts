// Turn orchestration for /api/chat.
//
// Owns the agent build, Paperclip reservation, OTel root span open, and
// the two main run paths:
//   - runNonStreamingTurn: agent.run / completeJson plan-mode → JSON reply
//   - runStreamingTurn:    setupSse → runHarness with SSE sink → caller
//                          finalizes via end-of-turn.ts
//
// Reuses buildAgent / runHarness / Paperclip client / OTel span helpers —
// no re-implementations.

import type { FastifyReply, FastifyRequest } from "fastify";
import { context as otelContext, trace } from "@opentelemetry/api";
import type { Config } from "../../config.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { SkillLoader } from "../../core/skills.js";
import { runHarness } from "../../core/harness.js";
import {
  Budget,
  BudgetExceededError,
  SessionBudgetExceededError,
} from "../../core/budget.js";
import { lifecycle } from "../../core/runtime.js";
import { OptimisticLockError } from "../../core/session-store.js";
import { AwaitingUserInputError } from "../../tools/builtins/ask_user.js";
import {
  planStore,
  createPlan,
  parsePlanSteps,
} from "../../core/plan-mode.js";
import { setupSse, writeEvent } from "../../streaming/sse.js";
import { makeSseSink } from "../../streaming/sse-sink.js";
import { recordSpanError } from "../../observability/spans.js";
import type { PaperclipClient } from "../../core/paperclip-client.js";
import type { RedactReplacement } from "../../core/hooks/redact-secrets.js";
import type { Pool } from "pg";
import type { ToolContext, Message } from "../../core/types.js";
import { finalizeStreamingTurn } from "./end-of-turn.js";
import { runPlanModeStreaming } from "./plan-mode.js";
import {
  reservePaperclipForTurn,
  releasePaperclipForNonStreaming,
  closeNonStreamingSpan,
  openRootSpan,
  buildAgentForTurn,
  type ReserveResult,
} from "./turn-helpers.js";
import type { ShadowEvaluator } from "../../prompts/shadow-evaluator.js";

export interface TurnOrchestrationDeps {
  config: Config;
  pool: Pool;
  llm: LlmProvider;
  registry: ToolRegistry;
  skillLoader?: SkillLoader;
  paperclip?: PaperclipClient;
  shadowEvaluator?: ShadowEvaluator;
}

interface TurnInputs {
  user: string;
  sessionId: string | null;
  sessionEtag: string | undefined;
  sessionInputUsed: number;
  sessionOutputUsed: number;
  sessionStepsUsed: number;
  sessionInputCap: number;
  sessionOutputCap: number;
  systemPrompt: string;
  activePromptVersion: number | undefined;
  cleanupSkillForTurn: (() => void) | undefined;
  isPlanMode: boolean;
  ctx: ToolContext;
  messages: Message[];
  lastUserContent: string;
  agentTraceId: string | undefined;
}

/**
 * Send the HTTP 429 + Retry-After response when Paperclip refused the
 * reservation. Both run paths (streaming and non-streaming) share the
 * identical envelope shape.
 */
function send429ForBudgetRefusal(
  reply: FastifyReply,
  refused: Extract<ReserveResult, { kind: "refused" }>,
): void {
  void reply
    .code(429)
    .header("Retry-After", String(refused.retryAfterSeconds))
    .send({
      error: "budget_exceeded",
      reason: refused.reason,
      retry_after_seconds: refused.retryAfterSeconds,
    });
}

/**
 * Non-streaming chat path. Plan-mode returns the JSON plan; otherwise
 * runs a synchronous agent.run() and returns text + finishReason + usage.
 *
 * Mirrors the streaming path's Paperclip + rootSpan wiring so daily-USD
 * caps and Langfuse trace tagging apply uniformly. The route caller MUST
 * `return` after this resolves — the response is closed.
 */
export async function runNonStreamingTurn(
  req: FastifyRequest,
  reply: FastifyReply,
  state: TurnInputs,
  deps: TurnOrchestrationDeps,
): Promise<void> {
  const reserveResult = await reservePaperclipForTurn(
    req,
    deps.paperclip,
    state.user,
    state.sessionId,
  );
  if (reserveResult.kind === "refused") {
    state.cleanupSkillForTurn?.();
    send429ForBudgetRefusal(reply, reserveResult);
    return;
  }
  const paperclipHandle = reserveResult.handle;

  const rootSpan = openRootSpan({
    agentTraceId: state.agentTraceId,
    sessionId: state.sessionId,
    user: state.user,
    agentModel: deps.config.AGENT_MODEL,
    activePromptVersion: state.activePromptVersion,
  });

  const { agent } = buildAgentForTurn(deps);

  try {
    if (state.isPlanMode) {
      // Plan mode: ask LLM to produce a JSON plan; no tool execution.
      // Run the completeJson call inside the rootSpan's OTel context so
      // LiteLLM's auto-instrumentation parents its trace under the root
      // and inherits the prompt:agent.system tag (deep-review #6).
      const planJson = await otelContext.with(
        trace.setSpan(otelContext.active(), rootSpan),
        () =>
          deps.llm.completeJson({
            system: state.systemPrompt,
            user: state.lastUserContent,
          }),
      );
      const steps = parsePlanSteps(planJson);
      const plan = createPlan(steps, state.messages, state.user);
      planStore.save(plan);
      state.cleanupSkillForTurn?.();
      closeNonStreamingSpan(rootSpan, deps.config.AGENT_MODEL, 0, 0);
      await releasePaperclipForNonStreaming(req, paperclipHandle, 0, 0);
      void reply.send({
        plan_id: plan.plan_id,
        steps: plan.steps,
        created_at: plan.created_at,
      });
      return;
    }
    const result = await otelContext.with(
      trace.setSpan(otelContext.active(), rootSpan),
      () => agent.run({ messages: state.messages, ctx: state.ctx }),
    );
    state.cleanupSkillForTurn?.();
    closeNonStreamingSpan(
      rootSpan,
      deps.config.AGENT_MODEL,
      result.usage.promptTokens,
      result.usage.completionTokens,
    );
    await releasePaperclipForNonStreaming(
      req,
      paperclipHandle,
      result.usage.promptTokens,
      result.usage.completionTokens,
    );
    void reply.send({ text: result.text, finishReason: result.finishReason, usage: result.usage });
    return;
  } catch (err) {
    req.log.error({ err }, "chat generate failed");
    state.cleanupSkillForTurn?.();
    try { recordSpanError(rootSpan, err); } catch { /* ignore */ }
    closeNonStreamingSpan(rootSpan, deps.config.AGENT_MODEL, 0, 0);
    await releasePaperclipForNonStreaming(req, paperclipHandle, 0, 0);
    void reply.code(500).send({ error: "internal" });
    return;
  }
}

/**
 * Streaming chat path. Sets up SSE, opens the root span, optionally runs
 * plan-mode (emit plan_step + plan_ready + finish) or token-streams via
 * runHarness, then hands off to finalizeStreamingTurn for the finally
 * block.
 *
 * The route caller MUST `return` after this resolves; the response is
 * closed by finalizeStreamingTurn.
 */
export async function runStreamingTurn(
  req: FastifyRequest,
  reply: FastifyReply,
  state: TurnInputs,
  deps: TurnOrchestrationDeps,
): Promise<void> {
  const reserveResult = await reservePaperclipForTurn(
    req,
    deps.paperclip,
    state.user,
    state.sessionId,
  );
  if (reserveResult.kind === "refused") {
    state.cleanupSkillForTurn?.();
    send429ForBudgetRefusal(reply, reserveResult);
    return;
  }
  const paperclipHandle = reserveResult.handle;

  const rootSpan = openRootSpan({
    agentTraceId: state.agentTraceId,
    sessionId: state.sessionId,
    user: state.user,
    agentModel: deps.config.AGENT_MODEL,
    activePromptVersion: state.activePromptVersion,
  });

  // ── SSE preamble ──────────────────────────────────────────────────────
  setupSse(reply);

  // NOTE: onSession fires BEFORE pre_turn (when both streamSink and
  // sessionId are set) — runHarness drives the `session` SSE event via
  // the sink. We do NOT emit it here directly — that would double-fire
  // when runHarness runs.

  let closed = false;
  const onClose = () => { closed = true; };
  req.raw.on("close", onClose);
  req.raw.on("aborted", onClose);

  // Hoisted out so finally can read them.
  let finishReason = "stop";
  // Streaming redaction log: each text_delta is scrubbed in flight via the
  // sink's onTextDelta (makeSseSink wraps redactString); replacements
  // accumulate here so the route's finally can persist them to scratchpad
  // for observability.
  //
  // TODO(disconnect-mid-stream): runHarness doesn't accept an AbortSignal,
  // so a client close mid-stream cannot abort the harness loop. Writes to
  // a closed reply silently no-op via Fastify, but the LLM call (and any
  // outstanding tool calls) run to completion. A future phase should plumb
  // an AbortController through runHarness if mid-stream cost becomes an
  // issue.
  const streamRedactions: RedactReplacement[] = [];
  let budget: Budget | undefined;

  const { tools, effectiveMaxSteps } = buildAgentForTurn(deps);

  // Make rootSpan the active OTel context for the rest of the turn so
  // every LiteLLM auto-instrumented call inherits the parent and the
  // `prompt:agent.system` tag.
  const turnCtx = trace.setSpan(otelContext.active(), rootSpan);

  try {
    // Plan mode: ask LLM for a JSON plan; emit plan_step + plan_ready; no tool execution.
    if (state.isPlanMode) {
      const planResult = await otelContext.with(turnCtx, () =>
        runPlanModeStreaming(req, reply, {
          pool: deps.pool,
          llm: deps.llm,
          user: state.user,
          sessionId: state.sessionId,
          messages: state.messages,
          systemPrompt: state.systemPrompt,
          lastUserContent: state.lastUserContent,
          isClosed: () => closed,
          rootSpan,
          cleanupSkillForTurn: state.cleanupSkillForTurn,
        }),
      );
      finishReason = planResult.finishReason;
      return;
    }

    // Token-by-token streaming path — delegated to runHarness with an SSE sink.
    //
    // The sink does NOT expose onAwaitingUserInput — the route's finally
    // block lifts the awaiting_question from scratchpad, redacts it,
    // persists it to the session row, and emits the SSE event. Wiring the
    // sink's onAwaitingUserInput would emit an unredacted question before
    // the session save, which is the wrong order for both the wire and the DB.
    //
    // Likewise the sink does NOT expose onFinish — the route's finally
    // emits `finish` AFTER the saveSession + awaiting_user_input emit, which
    // is part of the public SSE wire contract. (The harness's onFinish is
    // a no-op when the sink omits the callback.)
    const sink = makeSseSink(reply, streamRedactions, state.sessionId ?? undefined);
    // Strip the two callbacks the route owns. The sink object is freshly
    // built here so deleting on it doesn't leak anywhere else.
    delete (sink as { onAwaitingUserInput?: unknown }).onAwaitingUserInput;
    delete (sink as { onFinish?: unknown }).onFinish;

    budget = new Budget({
      maxSteps: effectiveMaxSteps,
      maxPromptTokens: deps.config.AGENT_TOKEN_BUDGET,
      // Phase F: charge against the session-level cap on every step.
      // sessionId being null means stateless — skip the session cap.
      session: state.sessionId
        ? {
            inputUsed: state.sessionInputUsed,
            outputUsed: state.sessionOutputUsed,
            inputCap: state.sessionInputCap,
            outputCap: state.sessionOutputCap,
          }
        : undefined,
    });

    const result = await runHarness({
      messages: state.messages,
      tools,
      llm: deps.llm,
      budget,
      lifecycle,
      ctx: state.ctx,
      streamSink: sink,
      sessionId: state.sessionId ?? undefined,
    });

    finishReason = result.finishReason;
  } catch (err) {
    // Distinguish typed control-flow / quota errors so clients can render
    // appropriate UI.
    if (err instanceof SessionBudgetExceededError) {
      req.log.warn({ err }, "chat stream stopped: session budget exceeded");
      finishReason = "session_budget_exceeded";
      if (!closed) {
        writeEvent(reply, { type: "error", error: "session_budget_exceeded" });
      }
    } else if (err instanceof BudgetExceededError) {
      req.log.warn({ err }, "chat stream stopped: per-turn budget exceeded");
      finishReason = "budget_exceeded";
      if (!closed) {
        writeEvent(reply, { type: "error", error: "budget_exceeded" });
      }
    } else if (err instanceof OptimisticLockError) {
      req.log.warn({ err }, "chat stream stopped: concurrent modification");
      finishReason = "concurrent_modification";
      if (!closed) {
        writeEvent(reply, { type: "error", error: "concurrent_modification" });
      }
    } else if (err instanceof AwaitingUserInputError) {
      // runHarness re-throws AwaitingUserInputError after dispatching
      // post_turn (which persists the awaiting_question to scratchpad).
      // Treat as a normal awaiting-input exit, NOT an error — the route's
      // finally block lifts the question from scratchpad and emits the
      // awaiting_user_input SSE event.
      finishReason = "awaiting_user_input";
    } else {
      req.log.error({ err }, "chat stream failed");
      if (!closed) {
        writeEvent(reply, { type: "error", error: "internal" });
      }
    }
  } finally {
    await finalizeStreamingTurn(req, reply, {
      pool: deps.pool,
      user: state.user,
      sessionId: state.sessionId,
      ctx: state.ctx,
      messages: state.messages,
      budget,
      finishReason,
      closed,
      streamRedactions,
      sessionEtag: state.sessionEtag,
      sessionStepsUsed: state.sessionStepsUsed,
      paperclipHandle,
      rootSpan,
      shadowEvaluator: deps.shadowEvaluator,
      agentTraceId: state.agentTraceId,
      cleanupSkillForTurn: state.cleanupSkillForTurn,
      agentModel: deps.config.AGENT_MODEL,
    });
  }
}
