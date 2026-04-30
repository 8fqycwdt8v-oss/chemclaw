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
 * the string "plan_ready" so the caller can update its outer-scope
 * finishReason (which the outer finally's session_end gate inspects).
 * On error, returns undefined — the caller leaves finishReason
 * untouched, preserving the prior behaviour where a failed plan stays
 * at the "stop" default.
 *
 * Always closes the SSE response (success or failure) and runs the
 * cleanupSkillForTurn callback exactly once.
 */
export async function runPlanModeStreaming(
  req: FastifyRequest,
  reply: FastifyReply,
  input: PlanModeStreamingInput,
): Promise<"plan_ready" | undefined> {
  let finishReason: "plan_ready" | undefined;
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
    // Note: leave finishReason undefined so the caller's outer-scope
    // finishReason stays at its default ("stop"). Mirrors the prior
    // inline behaviour exactly — this does mean a failed plan still
    // triggers the outer finally's session_end gate, which is a
    // pre-existing footgun unrelated to this extraction.
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
