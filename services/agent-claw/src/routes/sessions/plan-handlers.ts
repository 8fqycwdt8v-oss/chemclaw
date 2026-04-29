// POST /api/sessions/:id/plan/run — Phase E chained plan execution.
//
// Loads the most-recent active plan for the session and runs harness turns
// until the plan is completed, max_steps is hit, the auto-chain cap fires,
// or the session-budget trips. Each turn appends to the session's message
// history. Returns the final state including current_step_index so clients
// can render an "X of N steps" badge.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Config } from "../../config.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { PaperclipClient } from "../../core/paperclip-client.js";
import { runChainedHarness } from "../../core/chained-harness.js";
import {
  loadActivePlanForSession,
  advancePlan,
} from "../../core/plan-store-db.js";

export interface PlanHandlersDeps {
  pool: Pool;
  config?: Config;
  llm?: LlmProvider;
  registry?: ToolRegistry;
  paperclip?: PaperclipClient;
  getUser: (req: FastifyRequest) => string;
}

/**
 * Run the active plan for a session through the chained harness, advancing
 * its step index as tool calls match planned steps. Maps the chained
 * harness's final state to a plan-status transition (completed / running /
 * failed) and returns the progress envelope the client UI consumes.
 */
export async function handlePlanRun(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
  deps: PlanHandlersDeps,
): Promise<void> {
  if (!deps.config || !deps.llm || !deps.registry) {
    void reply.code(500).send({ error: "harness_deps_missing" });
    return;
  }
  const cfg = deps.config;
  const llm = deps.llm;
  const registry = deps.registry;
  const pool = deps.pool;

  const user = deps.getUser(req);
  const sessionId = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    void reply.code(400).send({ error: "invalid_input", detail: "session id must be a UUID" });
    return;
  }
  const plan = await loadActivePlanForSession(pool, user, sessionId);
  if (!plan) {
    void reply.code(404).send({ error: "no_active_plan" });
    return;
  }

  await advancePlan(pool, user, plan.id, { status: "running" });

  const result = await runChainedHarness({
    pool,
    user,
    sessionId,
    messages: plan.initialMessages,
    cfg,
    llm,
    registry,
    paperclip: deps.paperclip,
    log: req.log,
    // Phase F4: pass the plan so the runner can advance current_step_index
    // as tool calls match planned steps.
    planForProgress: {
      id: plan.id,
      steps: plan.steps,
      initialIndex: plan.currentStepIndex,
    },
  });

  // Mark plan as completed if the harness reported "stop", otherwise leave
  // it running for the next iteration.
  const finalIndex = result.planFinalStepIndex ?? plan.currentStepIndex;
  if (result.finalFinishReason === "stop") {
    // If we actually walked to the last step, mark completed; otherwise
    // the model "stopped" early — keep it running for a future call.
    const status = finalIndex >= plan.steps.length ? "completed" : "running";
    await advancePlan(pool, user, plan.id, {
      currentStepIndex: finalIndex,
      status,
    });
  } else if (result.finalFinishReason === "session_budget_exceeded") {
    await advancePlan(pool, user, plan.id, {
      currentStepIndex: finalIndex,
      status: "failed",
    });
  } else {
    // max_steps / awaiting_user_input / etc — persist progress, keep open.
    await advancePlan(pool, user, plan.id, { currentStepIndex: finalIndex });
  }

  void reply.code(200).send({
    plan_id: plan.id,
    session_id: sessionId,
    auto_turns_used: result.autoTurns,
    final_finish_reason: result.finalFinishReason,
    total_steps_used: result.totalSteps,
    // Plan progress info — clients render this as a "X of N steps" badge.
    plan_progress: {
      current_step_index: finalIndex,
      total_steps: plan.steps.length,
    },
  });
}
