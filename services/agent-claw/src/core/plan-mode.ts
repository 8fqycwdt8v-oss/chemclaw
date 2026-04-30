// Plan-mode preview + approve/reject lifecycle.
//
// When the user prefixes a request with /plan, the harness runs ONE step at a
// time and emits a structured plan_step SSE event for each anticipated tool call.
// After all steps are planned, a plan_ready event is emitted and execution PAUSES.
// No tool calls actually execute.
//
// Plans live in an in-process Map keyed by plan_id (UUID) with a 5-minute TTL.
// Phase D will wire Paperclip-lite for durable plan storage.
//
// SSE event types introduced here:
//   plan_step  — { step_number, tool, args, rationale }
//   plan_ready — { plan_id, steps: PlanStep[], created_at }

import { randomUUID } from "crypto";
import type { Message } from "./types.js";

// ---------------------------------------------------------------------------
// Plan step
// ---------------------------------------------------------------------------

export interface PlanStep {
  step_number: number;
  tool: string;
  args: unknown;
  rationale: string;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface Plan {
  plan_id: string;
  steps: PlanStep[];
  messages: Message[];
  /** Owner user-Entra-ID. /approve / /reject / GET refuse if the calling
   * user doesn't match. Closes cross-user plan hijack via leaked plan_id. */
  user_entra_id: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// In-process plan store (5-minute TTL).
// ---------------------------------------------------------------------------

const PLAN_TTL_MS = 5 * 60 * 1_000;

class PlanStore {
  private readonly _plans = new Map<string, Plan>();

  save(plan: Plan): void {
    this._plans.set(plan.plan_id, plan);
    // Auto-expire.
    setTimeout(() => {
      this._plans.delete(plan.plan_id);
    }, PLAN_TTL_MS);
  }

  get(planId: string): Plan | undefined {
    return this._plans.get(planId);
  }

  delete(planId: string): boolean {
    return this._plans.delete(planId);
  }

  /** Current size (for tests). */
  get size(): number {
    return this._plans.size;
  }
}

// Singleton store.
export const planStore = new PlanStore();

// ---------------------------------------------------------------------------
// Build a new Plan from raw LLM planned steps.
// ---------------------------------------------------------------------------

export function createPlan(
  steps: PlanStep[],
  messages: Message[],
  userEntraId: string,
): Plan {
  return {
    plan_id: randomUUID(),
    steps,
    messages: messages.map((m) => ({ ...m })), // shallow clone
    user_entra_id: userEntraId,
    created_at: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// SSE event types for plan mode.
// ---------------------------------------------------------------------------

export interface PlanStepEvent {
  type: "plan_step";
  step_number: number;
  tool: string;
  args: unknown;
  rationale: string;
}

export interface PlanReadyEvent {
  type: "plan_ready";
  plan_id: string;
  steps: PlanStep[];
  created_at: number;
}

// ---------------------------------------------------------------------------
// Plan parser — extract tool calls from the LLM's plan text.
//
// The harness asks the LLM to produce a JSON array of planned steps.
// This function parses the response and returns PlanStep[].
// ---------------------------------------------------------------------------

interface RawPlanStep {
  tool?: unknown;
  args?: unknown;
  rationale?: unknown;
}

export function parsePlanSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];

  return (raw as RawPlanStep[])
    .filter((s) => typeof s.tool === "string" && s.tool.trim() !== "")
    .map((s, idx) => ({
      step_number: idx + 1,
      tool: String(s.tool),
      args: s.args ?? {},
      rationale: typeof s.rationale === "string" ? s.rationale : "",
    }));
}

// ---------------------------------------------------------------------------
// The system-prompt suffix that instructs the LLM to produce a plan.
// Injected by the route when verb === "plan".
// ---------------------------------------------------------------------------

export const PLAN_MODE_SYSTEM_SUFFIX = `

## Plan mode instructions

You are in PLAN MODE. Do not execute any tool calls.
Instead, analyze the user's request and output a JSON array of planned steps.
Each step must have: { "tool": "<tool_id>", "args": { ... }, "rationale": "why this step" }.
Output ONLY valid JSON — no prose, no markdown fences.
Example:
[
  { "tool": "canonicalize_smiles", "args": { "smiles": "CCO" }, "rationale": "Normalize input before search" },
  { "tool": "find_similar_reactions", "args": { "smiles": "<canonical>" }, "rationale": "Find analogous reactions" }
]
`;
