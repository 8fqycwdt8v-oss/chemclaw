// Tests for the plan-mode module: plan creation, store TTL, approve/reject lifecycle.

import { describe, it, expect, beforeEach } from "vitest";
import {
  planStore,
  createPlan,
  parsePlanSteps,
  PLAN_MODE_SYSTEM_SUFFIX,
  type PlanStep,
} from "../../src/core/plan-mode.js";

describe("parsePlanSteps — input parsing", () => {
  it("parses a valid array of planned steps", () => {
    const raw = [
      { tool: "canonicalize_smiles", args: { smiles: "CCO" }, rationale: "normalize" },
      { tool: "find_similar_reactions", args: { smiles: "canonical" }, rationale: "search" },
    ];
    const steps = parsePlanSteps(raw);
    expect(steps.length).toBe(2);
    expect(steps[0]?.step_number).toBe(1);
    expect(steps[0]?.tool).toBe("canonicalize_smiles");
    expect(steps[1]?.step_number).toBe(2);
    expect(steps[1]?.rationale).toBe("search");
  });

  it("skips entries without a tool name", () => {
    const raw = [
      { tool: "canonicalize_smiles", args: {} },
      { rationale: "no tool here" },
      { tool: "", args: {} },
    ];
    const steps = parsePlanSteps(raw);
    expect(steps.length).toBe(1);
    expect(steps[0]?.tool).toBe("canonicalize_smiles");
  });

  it("returns empty array for non-array input", () => {
    expect(parsePlanSteps(null)).toEqual([]);
    expect(parsePlanSteps("not an array")).toEqual([]);
    expect(parsePlanSteps(42)).toEqual([]);
  });

  it("fills in empty rationale when missing", () => {
    const raw = [{ tool: "query_kg", args: { entity_id: "EXP-001" } }];
    const steps = parsePlanSteps(raw);
    expect(steps[0]?.rationale).toBe("");
  });
});

describe("planStore — save and retrieve", () => {
  beforeEach(() => {
    // Nothing to reset — the store is a singleton but each test uses unique IDs.
  });

  it("saves a plan and retrieves it by plan_id", () => {
    const steps: PlanStep[] = [
      { step_number: 1, tool: "search_knowledge", args: {}, rationale: "find docs" },
    ];
    const plan = createPlan(steps, [{ role: "user", content: "find docs" }]);
    planStore.save(plan);
    const retrieved = planStore.get(plan.plan_id);
    expect(retrieved).toBeTruthy();
    expect(retrieved?.plan_id).toBe(plan.plan_id);
    expect(retrieved?.steps.length).toBe(1);
  });

  it("returns undefined for an unknown plan_id", () => {
    expect(planStore.get("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });

  it("deletes a plan and returns true", () => {
    const plan = createPlan([], []);
    planStore.save(plan);
    const result = planStore.delete(plan.plan_id);
    expect(result).toBe(true);
    expect(planStore.get(plan.plan_id)).toBeUndefined();
  });

  it("returns false when deleting a non-existent plan", () => {
    expect(planStore.delete("00000000-0000-0000-0000-000000000099")).toBe(false);
  });

  it("createPlan assigns a unique UUID each time", () => {
    const p1 = createPlan([], []);
    const p2 = createPlan([], []);
    expect(p1.plan_id).not.toBe(p2.plan_id);
  });
});

describe("PLAN_MODE_SYSTEM_SUFFIX", () => {
  it("contains instructions to output JSON only", () => {
    expect(PLAN_MODE_SYSTEM_SUFFIX).toContain("PLAN MODE");
    expect(PLAN_MODE_SYSTEM_SUFFIX).toContain("JSON");
    expect(PLAN_MODE_SYSTEM_SUFFIX).toContain("tool");
  });
});

describe("plan TTL (simulated)", () => {
  it("plan survives immediately after saving", () => {
    const plan = createPlan([], []);
    planStore.save(plan);
    expect(planStore.get(plan.plan_id)).toBeTruthy();
    planStore.delete(plan.plan_id); // cleanup
  });

  it("plan can be manually deleted before TTL expires", () => {
    const plan = createPlan([], []);
    planStore.save(plan);
    planStore.delete(plan.plan_id);
    expect(planStore.get(plan.plan_id)).toBeUndefined();
  });
});
