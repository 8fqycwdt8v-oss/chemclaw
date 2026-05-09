// manage_plan — adaptive replanning surface for the agent.
//
// Lets the LLM amend the active plan mid-execution: insert a remedial step
// when a downstream step turned out to need a precondition, remove a step
// that's no longer relevant, or replace the entire step list when the plan
// itself needs to be re-conceived. Without this tool the original plan was
// write-once after approval; the only escape from a wrong plan was to
// break out via ask_user.
//
// Persistence: agent_plans (RLS-scoped via the parent agent_sessions row).
// Requires session_id in ctx.scratchpad — same precondition as manage_todos.
// Operates on the most-recent active plan (status ∈ proposed/approved/running).
//
// The tool refuses to mutate the cursor itself (current_step_index) — that's
// owned by the chained-harness plan-progress walker. Removing a step before
// the cursor shifts the cursor; the helper handles that automatically.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import {
  loadActivePlanForSession,
  insertPlanStepAt,
  removePlanStepAt,
  replacePlanSteps,
  type DbPlan,
} from "../../core/plan-store-db.js";
import type { PlanStep } from "../../core/plan-mode.js";

const PlanStepIn = z.object({
  tool: z.string().min(1).max(120),
  args: z.unknown(),
  rationale: z.string().min(1).max(2000),
});

export const ManagePlanIn = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("insert"),
    /** 0-indexed position; clamped into [0, steps.length]. */
    at: z.number().int().min(0),
    step: PlanStepIn,
  }),
  z.object({
    action: z.literal("remove"),
    at: z.number().int().min(0),
  }),
  z.object({
    action: z.literal("replace"),
    steps: z.array(PlanStepIn).min(1).max(50),
  }),
  z.object({
    action: z.literal("inspect"),
  }),
]);
export type ManagePlanInput = z.infer<typeof ManagePlanIn>;

const PlanStepOut = z.object({
  step_number: z.number(),
  tool: z.string(),
  args: z.unknown(),
  rationale: z.string(),
});

export const ManagePlanOut = z.object({
  plan_id: z.string(),
  status: z.string(),
  current_step_index: z.number(),
  steps: z.array(PlanStepOut),
  notice: z.string().optional(),
});
export type ManagePlanOutput = z.infer<typeof ManagePlanOut>;

const DESCRIPTION = [
  "Amend the active plan mid-execution. Use this when a step has failed",
  "repeatedly, when you discover a missing precondition, or when the plan",
  "itself was wrong. Actions:",
  "  insert  — add a step at position `at` (0-indexed; clamped).",
  "  remove  — drop the step at position `at`.",
  "  replace — replace the entire step list (use sparingly).",
  "  inspect — return the current plan without mutating.",
  "Returns the updated plan including its current_step_index. Steps are",
  "automatically renumbered after every mutation. If no active plan",
  "exists, returns notice='no_active_plan'.",
].join(" ");

function planToOutput(plan: DbPlan, notice?: string): ManagePlanOutput {
  return {
    plan_id: plan.id,
    status: plan.status,
    current_step_index: plan.currentStepIndex,
    steps: plan.steps.map((s) => ({
      step_number: s.step_number,
      tool: s.tool,
      args: s.args,
      rationale: s.rationale,
    })),
    notice,
  };
}

export function buildManagePlanTool(pool: Pool) {
  return defineTool({
    id: "manage_plan",
    description: DESCRIPTION,
    inputSchema: ManagePlanIn,
    outputSchema: ManagePlanOut,
    annotations: { readOnly: false },

    execute: async (ctx, input): Promise<ManagePlanOutput> => {
      const sessionId = ctx.scratchpad.get("session_id");
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new Error(
          "manage_plan requires an active session_id in scratchpad. " +
            "If you intended to operate without state, do not call this tool.",
        );
      }

      const plan = await loadActivePlanForSession(
        pool,
        ctx.userEntraId,
        sessionId,
      );
      if (!plan) {
        // Synthetic empty-plan output — `plan_id` is empty so the model
        // cannot accidentally pass it back. The notice tells it what to
        // do next. Returning successfully (rather than throwing) keeps
        // the chain alive while the model decides whether to /plan or
        // proceed without one.
        return {
          plan_id: "",
          status: "missing",
          current_step_index: 0,
          steps: [],
          notice: "no_active_plan",
        };
      }

      switch (input.action) {
        case "inspect": {
          return planToOutput(plan);
        }
        case "insert": {
          const updated = await insertPlanStepAt(
            pool,
            ctx.userEntraId,
            plan.id,
            input.at,
            {
              tool: input.step.tool,
              args: input.step.args,
              rationale: input.step.rationale,
            } as Omit<PlanStep, "step_number">,
          );
          if (!updated) {
            return planToOutput(plan, "insert_failed");
          }
          return planToOutput(updated);
        }
        case "remove": {
          const updated = await removePlanStepAt(
            pool,
            ctx.userEntraId,
            plan.id,
            input.at,
          );
          if (!updated) {
            return planToOutput(plan, "remove_failed");
          }
          // Communicate the no-op when `at` was out-of-range.
          if (updated.steps.length === plan.steps.length) {
            return planToOutput(updated, "remove_out_of_range");
          }
          return planToOutput(updated);
        }
        case "replace": {
          const newSteps: PlanStep[] = input.steps.map((s, i) => ({
            step_number: i + 1,
            tool: s.tool,
            args: s.args,
            rationale: s.rationale,
          }));
          const updated = await replacePlanSteps(
            pool,
            ctx.userEntraId,
            plan.id,
            newSteps,
          );
          if (!updated) {
            return planToOutput(plan, "replace_failed");
          }
          return planToOutput(updated);
        }
      }
    },
  });
}
