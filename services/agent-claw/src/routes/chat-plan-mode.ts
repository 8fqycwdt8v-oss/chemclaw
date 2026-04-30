// Plan-mode SSE branch for the chat route.
//
// Extracted from routes/chat.ts. When the user types `/plan ...` the
// chat handler asks the LLM for a JSON plan instead of running tools,
// emits one `plan_step` SSE event per planned step, persists the plan
// (in-memory + DB), and emits the terminal `plan_ready` + `finish`
// pair. No harness call, no post_turn dispatch — owns its own
// try/catch/finally lifetime.
//
// The function returns the finishReason it set ("plan_ready" on success,
// "plan_mode_failed" on an LLM-side or parse error) so the outer chat
// handler's finally block sees the correct terminal state for its
// saveSession + shadow-eval gate.

import type { FastifyRequest, FastifyReply } from "fastify";
import type { Context } from "@opentelemetry/api";
import { context as otelContext } from "@opentelemetry/api";
import type { Pool } from "pg";
import type { LlmProvider } from "../llm/provider.js";
import { createPlan, parsePlanSteps, planStore } from "../core/plan-mode.js";
import { savePlanForSession } from "../core/plan-store-db.js";
import { writeEvent } from "../streaming/sse.js";
import type { Message } from "../core/types.js";

export interface PlanModeStreamingInput {
  llm: LlmProvider;
  pool: Pool;
  systemPrompt: string;
  lastUserContent: string;
  messages: Message[];
  user: string;
  sessionId: string | null;
  /** Boxed close flag — see chat.ts. Property reads aren't narrowed by
   *  TS so the post-handler closure can flip it true and our reads see
   *  the new value. */
  conn: { closed: boolean };
  /** OTel turn context — the LLM call runs `otelContext.with(turnCtx, …)`
   *  so it inherits the rootSpan and the prompt:agent.system tag. */
  turnCtx: Context;
  signal: AbortSignal;
  /** Cleanup hook for any turn-scoped skill activation. Called once in
   *  the inner finally. */
  cleanupSkillForTurn: (() => void) | undefined;
}

/**
 * Run the streaming plan-mode branch end-to-end. On success, returns
 * either "plan_ready" (success) or "error" (LLM/parse failure) so the
 * caller can update its outer-scope finishReason. Both values are in
 * the DB CHECK on agent_sessions.last_finish_reason (init/18) and the
 * SessionFinishReason TS union, so the outer finally's
 * persistTurnState write succeeds and the session_end gate (which
 * fires on "stop" only) correctly skips both paths.
 *
 * Always closes the SSE response (success or failure). Does NOT call
 * cleanupSkillForTurn — the caller's outer finally owns that.
 */
export async function runPlanModeStreaming(
  req: FastifyRequest,
  reply: FastifyReply,
  input: PlanModeStreamingInput,
): Promise<"plan_ready" | "error"> {
  let finishReason: "plan_ready" | "error";
  try {
    const planJson = await otelContext.with(input.turnCtx, () =>
      input.llm.completeJson({
        system: input.systemPrompt,
        user: input.lastUserContent,
        signal: input.signal,
      }),
    );
    const steps = parsePlanSteps(planJson);

    // Emit plan_step events.
    for (const step of steps) {
      if (input.conn.closed) break;
      writeEvent(reply, {
        type: "plan_step",
        step_number: step.step_number,
        tool: step.tool,
        args: step.args,
        rationale: step.rationale,
      });
    }

    // Save the plan to:
    //   1. The legacy in-memory planStore — kept for backward-compat with
    //      /api/chat/plan/approve and existing tests.
    //   2. The DB-backed agent_plans table — used by Phase E chained
    //      execution via /api/sessions/:id/plan/run.
    const plan = createPlan(steps, input.messages, input.user);
    planStore.save(plan);

    // DB persistence requires a session id. If we couldn't create one
    // earlier, the plan is in-memory only and the chained-run endpoint
    // won't find it — fine, the legacy approve path still works.
    if (input.sessionId) {
      try {
        await savePlanForSession(input.pool, input.user, input.sessionId, steps, input.messages);
      } catch (err) {
        req.log.warn({ err }, "savePlanForSession failed; falling back to in-memory");
      }
    }

    if (!input.conn.closed) {
      writeEvent(reply, {
        type: "plan_ready",
        plan_id: plan.plan_id,
        steps: plan.steps,
        created_at: plan.created_at,
      });
      writeEvent(reply, {
        type: "finish",
        finishReason: "plan_ready",
        usage: { promptTokens: 0, completionTokens: 0 },
      });
    }
    // Reflect plan-ready into the outer-scope finishReason via the
    // return value so the outer finally's saveSession + shadow-eval
    // gate sees the correct terminal state.
    finishReason = "plan_ready";
  } catch (err) {
    req.log.error({ err }, "plan-mode failed");
    if (!input.conn.closed) writeEvent(reply, { type: "error", error: "plan_mode_failed" });
    // Map plan-mode failures to "error" so:
    //   1. agent_sessions.last_finish_reason records 'error' (the DB
    //      CHECK widened in init/18 allows it).
    //   2. The outer finally's session_end gate (which fires on "stop")
    //      does NOT mis-fire for a plan-mode failure.
    // Pre-PR #61 / pre-cycle-2-review this returned undefined which
    // left the caller's outer finishReason at "stop" — the same
    // generic-error-as-clean-stop bug PR #61 fixed for classify-stream-error.
    // Cycle-1 of review-v2 caught the parallel hole here.
    finishReason = "error";
  } finally {
    // Note: cleanupSkillForTurn is intentionally NOT called here — the
    // caller's outer finally in chat.ts owns it. The pre-PR-56 inline
    // version called it in both places (relying on
    // SkillLoader.enableForTurn being idempotent at the second
    // decrement); the post-session review (debug-investigator agent)
    // flagged this as a redundant double-call worth tightening up.
    // reply.raw.end() stays here because the outer finally writes
    // terminal-events that would double-emit `finish` on the wire if
    // the response weren't already closed.
    try { reply.raw.end(); } catch { /* already closed */ }
  }
  return finishReason;
}
