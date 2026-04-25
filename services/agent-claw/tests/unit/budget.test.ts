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
});
