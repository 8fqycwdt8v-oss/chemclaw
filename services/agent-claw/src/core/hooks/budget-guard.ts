// pre_tool hook: budget-guard
//
// Checks the per-turn token budget BEFORE a tool is executed and throws
// BudgetExceededError if the projected total would exceed AGENT_TOKEN_BUDGET.
//
// This is distinct from the per-step token cap in Budget.consumeStep():
//   - consumeStep() measures *actual* usage after the LLM responds.
//   - budget-guard projects *expected* usage before tool execution.
//
// The projection is conservative: each tool call is estimated at a fixed
// overhead (configurable via AGENT_TOOL_TOKEN_OVERHEAD, default 500 tokens).
// Phase D will replace this with a Paperclip-lite call that has real USD
// accounting and per-user daily caps.
//
// The hook reads current usage from ctx.scratchpad.budget (set by the harness).

import type { PreToolPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";
import { BudgetExceededError } from "../budget.js";

// Expected shape of ctx.scratchpad.budget (set by the chat route or harness).
export interface BudgetScratch {
  promptTokensUsed: number;
  completionTokensUsed: number;
  tokenBudget: number;
  /** Estimated overhead per tool call. Default 500 tokens. */
  toolOverhead?: number;
}

const DEFAULT_TOOL_OVERHEAD = 500;

/**
 * Check if executing the next tool would exceed the token budget.
 * Throws BudgetExceededError if so.
 */
export async function budgetGuardHook(payload: PreToolPayload): Promise<void> {
  const budgetScratch = payload.ctx.scratchpad.get("budget") as BudgetScratch | undefined;

  // If no budget scratch is set, the guard is a no-op (graceful degradation).
  if (!budgetScratch) return;

  const used = budgetScratch.promptTokensUsed + budgetScratch.completionTokensUsed;
  const overhead = budgetScratch.toolOverhead ?? DEFAULT_TOOL_OVERHEAD;
  const projected = used + overhead;

  if (projected > budgetScratch.tokenBudget) {
    throw new BudgetExceededError(
      `budget-guard: projected token usage ${projected} would exceed budget ${budgetScratch.tokenBudget} (used=${used}, overhead=${overhead})`,
      "prompt_tokens",
    );
  }
}

/**
 * Register the budget-guard hook into a Lifecycle instance.
 */
export function registerBudgetGuardHook(lifecycle: Lifecycle): void {
  lifecycle.on("pre_tool", "budget-guard", budgetGuardHook);
}
