// Tests for token + step cap enforcement in Budget.

import { describe, it, expect } from "vitest";
import { Budget, BudgetExceededError } from "../../src/core/budget.js";

describe("Budget — token and step caps", () => {
  it("throws RangeError on construction when maxSteps <= 0", () => {
    expect(() => new Budget({ maxSteps: 0 })).toThrow(RangeError);
    expect(() => new Budget({ maxSteps: -1 })).toThrow(RangeError);
  });

  it("isStepCapReached() returns false before cap, true after", () => {
    const budget = new Budget({ maxSteps: 2 });
    expect(budget.isStepCapReached()).toBe(false);

    budget.consumeStep({ promptTokens: 10, completionTokens: 5 });
    expect(budget.isStepCapReached()).toBe(false);

    budget.consumeStep({ promptTokens: 10, completionTokens: 5 });
    expect(budget.isStepCapReached()).toBe(true);
  });

  it("consumeStep() throws BudgetExceededError when prompt token cap exceeded", () => {
    const budget = new Budget({ maxSteps: 10, maxPromptTokens: 100 });
    expect(() =>
      budget.consumeStep({ promptTokens: 101, completionTokens: 0 }),
    ).toThrow(BudgetExceededError);
  });

  it("consumeStep() throws BudgetExceededError when completion token cap exceeded", () => {
    const budget = new Budget({ maxSteps: 10, maxCompletionTokens: 50 });
    expect(() =>
      budget.consumeStep({ promptTokens: 0, completionTokens: 51 }),
    ).toThrow(BudgetExceededError);
  });

  it("BudgetExceededError carries the correct dimension", () => {
    const budget = new Budget({ maxSteps: 10, maxPromptTokens: 100 });
    let caught: BudgetExceededError | null = null;
    try {
      budget.consumeStep({ promptTokens: 200, completionTokens: 0 });
    } catch (err) {
      caught = err as BudgetExceededError;
    }
    expect(caught).toBeInstanceOf(BudgetExceededError);
    expect(caught?.dimension).toBe("prompt_tokens");
  });

  it("summary() returns cumulative token counts", () => {
    const budget = new Budget({ maxSteps: 10 });
    budget.consumeStep({ promptTokens: 100, completionTokens: 20 });
    budget.consumeStep({ promptTokens: 150, completionTokens: 30 });

    const { promptTokens, completionTokens } = budget.summary();
    expect(promptTokens).toBe(250);
    expect(completionTokens).toBe(50);
  });

  it("stepsUsed increments after each consumeStep", () => {
    const budget = new Budget({ maxSteps: 5 });
    expect(budget.stepsUsed).toBe(0);
    budget.consumeStep({ promptTokens: 10, completionTokens: 5 });
    budget.consumeStep({ promptTokens: 10, completionTokens: 5 });
    expect(budget.stepsUsed).toBe(2);
  });

  it("shouldCompact uses current window (latest call), not cumulative spend", () => {
    // 10_000-token cap (ample headroom for cumulative), 0.06 threshold =
    // compact when the LATEST call's prompt size >= 600. Three calls of
    // 300, 300, 700 would cumulate to 1_300 — a cumulative-based trigger
    // would fire after step 2 (cumulative 600 ≥ 600). The current-window
    // trigger fires only when one call's prompt size crosses on its own.
    const budget = new Budget({
      maxSteps: 10,
      maxPromptTokens: 10_000,
      compactionThreshold: 0.06,
    });
    budget.consumeStep({ promptTokens: 300, completionTokens: 0 });
    expect(budget.shouldCompact()).toBe(false);
    budget.consumeStep({ promptTokens: 300, completionTokens: 0 });
    // Pre-fix this would be true (cumulative 600 ≥ 600). Post-fix the
    // latest call's window is 300 — under the threshold.
    expect(budget.shouldCompact()).toBe(false);

    // Single call crosses the threshold on its own.
    budget.consumeStep({ promptTokens: 700, completionTokens: 0 });
    expect(budget.shouldCompact()).toBe(true);
    expect(budget.currentPromptTokens).toBe(700);

    // Cumulative spend remains the sum across calls (used for cost).
    expect(budget.summary().promptTokens).toBe(1_300);

    // resetPromptTokens shrinks the current-window estimate without
    // refunding cumulative spend.
    budget.resetPromptTokens(100);
    expect(budget.shouldCompact()).toBe(false);
    expect(budget.summary().promptTokens).toBe(1_300);
  });
});
