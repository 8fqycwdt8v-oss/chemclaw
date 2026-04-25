// Tests for the budget-guard pre_tool hook.

import { describe, it, expect } from "vitest";
import { budgetGuardHook } from "../../src/core/hooks/budget-guard.js";
import { BudgetExceededError } from "../../src/core/budget.js";
import type { PreToolPayload } from "../../src/core/types.js";
import type { BudgetScratch } from "../../src/core/hooks/budget-guard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(budget?: BudgetScratch): PreToolPayload {
  const scratchpad = new Map<string, unknown>();
  if (budget) {
    scratchpad.set("budget", budget);
  }
  return {
    ctx: {
      userEntraId: "test@example.com",
      scratchpad,
    },
    toolId: "some_tool",
    input: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("budgetGuardHook", () => {
  it("is a no-op when no budget scratch is set", async () => {
    const payload = makePayload(); // no budget in scratchpad
    // Should not throw.
    await expect(budgetGuardHook(payload)).resolves.toBeUndefined();
  });

  it("passes when projected usage is within budget", async () => {
    const payload = makePayload({
      promptTokensUsed: 1000,
      completionTokensUsed: 200,
      tokenBudget: 10_000,
      toolOverhead: 500,
    });
    // 1200 + 500 = 1700 < 10000 — should pass.
    await expect(budgetGuardHook(payload)).resolves.toBeUndefined();
  });

  it("throws BudgetExceededError when projected usage exceeds budget", async () => {
    const payload = makePayload({
      promptTokensUsed: 9_800,
      completionTokensUsed: 100,
      tokenBudget: 10_000,
      toolOverhead: 500,
    });
    // 9900 + 500 = 10400 > 10000 — should throw.
    await expect(budgetGuardHook(payload)).rejects.toThrow(BudgetExceededError);
  });

  it("uses default tool overhead of 500 when not specified", async () => {
    const payload = makePayload({
      promptTokensUsed: 9_600,
      completionTokensUsed: 100,
      tokenBudget: 10_000,
      // toolOverhead not set — defaults to 500
    });
    // 9700 + 500 = 10200 > 10000 — should throw.
    await expect(budgetGuardHook(payload)).rejects.toThrow(BudgetExceededError);
  });

  it("thrown error has dimension=prompt_tokens", async () => {
    const payload = makePayload({
      promptTokensUsed: 9_900,
      completionTokensUsed: 0,
      tokenBudget: 10_000,
      toolOverhead: 200,
    });
    let thrown: BudgetExceededError | null = null;
    try {
      await budgetGuardHook(payload);
    } catch (e) {
      thrown = e as BudgetExceededError;
    }
    expect(thrown).toBeInstanceOf(BudgetExceededError);
    expect(thrown!.dimension).toBe("prompt_tokens");
  });
});
