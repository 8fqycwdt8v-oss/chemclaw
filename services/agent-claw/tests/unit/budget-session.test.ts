// Tests for the cross-turn (session-level) budget added in Phase F.

import { describe, it, expect } from "vitest";
import { Budget, SessionBudgetExceededError } from "../../src/core/budget.js";

describe("Budget — session-level cap", () => {
  it("trips SessionBudgetExceededError when session input cap is reached", () => {
    const budget = new Budget({
      maxSteps: 100,
      maxPromptTokens: 10_000,
      session: {
        inputUsed: 9_500,
        outputUsed: 0,
        inputCap: 10_000,
        outputCap: 5_000,
      },
    });
    expect(() =>
      budget.consumeStep({ promptTokens: 600, completionTokens: 0 }),
    ).toThrow(SessionBudgetExceededError);
  });

  it("trips on output cap", () => {
    const budget = new Budget({
      maxSteps: 100,
      maxCompletionTokens: 10_000,
      session: {
        inputUsed: 0,
        outputUsed: 4_900,
        inputCap: 10_000,
        outputCap: 5_000,
      },
    });
    expect(() =>
      budget.consumeStep({ promptTokens: 0, completionTokens: 200 }),
    ).toThrow(SessionBudgetExceededError);
  });

  it("does not trip when totals stay below caps", () => {
    const budget = new Budget({
      maxSteps: 100,
      session: { inputUsed: 0, outputUsed: 0, inputCap: 10_000, outputCap: 5_000 },
    });
    budget.consumeStep({ promptTokens: 100, completionTokens: 50 });
    budget.consumeStep({ promptTokens: 100, completionTokens: 50 });
    const totals = budget.sessionTotals();
    expect(totals?.inputTokens).toBe(200);
    expect(totals?.outputTokens).toBe(100);
  });

  it("operates as legacy budget when session is undefined", () => {
    const budget = new Budget({ maxSteps: 100 });
    budget.consumeStep({ promptTokens: 50, completionTokens: 25 });
    expect(budget.sessionTotals()).toBeNull();
    expect(budget.summary()).toEqual({ promptTokens: 50, completionTokens: 25 });
  });
});
