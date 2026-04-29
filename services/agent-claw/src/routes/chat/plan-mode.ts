// Plan-mode runner for /api/chat (streaming branch).
//
// Asks the LLM to produce a JSON plan (no tool execution), emits
// plan_step events one at a time, persists the plan to both the legacy
// in-memory planStore and the DB-backed agent_plans table, then emits
// plan_ready + finish.
//
// The non-streaming plan branch is inline in turn-orchestration.ts; both
// paths share the same parsePlanSteps + createPlan + planStore.save
// trio, but the SSE path additionally drives DB persistence so
// /api/sessions/:id/plan/run can pick up the plan later.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { context as otelContext } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { LlmProvider } from "../../llm/provider.js";
import {
  planStore,
  createPlan,
  parsePlanSteps,
} from "../../core/plan-mode.js";
import { savePlanForSession } from "../../core/plan-store-db.js";
import { writeEvent } from "../../streaming/sse.js";
import type { Message } from "../../core/types.js";

export interface RunPlanModeStreamingArgs {
  pool: Pool;
  llm: LlmProvider;
  user: string;
  sessionId: string | null;
  messages: Message[];
  systemPrompt: string;
  lastUserContent: string;
  /** Closure that returns whether the client socket has closed. */
  isClosed: () => boolean;
  /** OTel root span — used to parent the completeJson call's auto-trace. */
  rootSpan: Span;
  /** Run after plan emission completes (success OR error path). */
  cleanupSkillForTurn: (() => void) | undefined;
}

/**
 * Run the SSE plan-mode branch end-to-end. Owns the full try/catch/finally
 * lifecycle: emits plan_step / plan_ready / finish on success, an `error`
 * event on failure, then runs cleanupSkillForTurn and closes the reply.
 *
 * Returns the final finish reason ("plan_ready" or "stop" if errored)
 * so the caller's outer turn-state can persist correctly.
 */
export async function runPlanModeStreaming(
  req: FastifyRequest,
  reply: FastifyReply,
  args: RunPlanModeStreamingArgs,
): Promise<{ finishReason: string }> {
  let finishReason = "stop";
  try {
    const planJson = await otelContext.with(otelContext.active(), () =>
      args.llm.completeJson({
        system: args.systemPrompt,
        user: args.lastUserContent,
      }),
    );
    const steps = parsePlanSteps(planJson);

    // Emit plan_step events.
    for (const step of steps) {
      if (args.isClosed()) break;
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
    const plan = createPlan(steps, args.messages, args.user);
    planStore.save(plan);

    // DB persistence requires a session id. If we couldn't create one
    // earlier, the plan is in-memory only and the chained-run endpoint
    // won't find it — fine, the legacy approve path still works.
    if (args.sessionId) {
      try {
        await savePlanForSession(
          args.pool,
          args.user,
          args.sessionId,
          steps,
          args.messages,
        );
      } catch (err) {
        req.log.warn({ err }, "savePlanForSession failed; falling back to in-memory");
      }
    }

    if (!args.isClosed()) {
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
    // Reflect plan-ready into the local var so the outer finally's
    // saveSession + shadow-eval gate see the correct terminal state.
    finishReason = "plan_ready";
  } catch (err) {
    req.log.error({ err }, "plan-mode failed");
    if (!args.isClosed()) writeEvent(reply, { type: "error", error: "plan_mode_failed" });
  } finally {
    args.cleanupSkillForTurn?.();
    try { reply.raw.end(); } catch { /* already closed */ }
  }
  return { finishReason };
}
