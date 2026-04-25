// pre_compact hook: compact-window — Phase C.1
//
// Fires at the pre_compact lifecycle point when the token estimate for the
// current message window exceeds 60% of AGENT_TOKEN_BUDGET.
//
// Action: replaces messages in-place with the compacted window returned by
// the compactor (system prompt + synopsis + recent N=3 turns).
//
// The hook reads the token budget from ctx.scratchpad.budget (same shape as
// budget-guard.ts's BudgetScratch). If no budget is found it is a no-op.

import type { PreCompactPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";
import type { LlmProvider } from "../../llm/provider.js";
import { shouldCompact, compact } from "../compactor.js";

export interface CompactWindowHookDeps {
  /** LLM provider used for the synopsis call. */
  llm: LlmProvider;
  /** Full token budget (AGENT_TOKEN_BUDGET). */
  tokenBudget: number;
  /** Trigger fraction (default 0.60). */
  triggerFraction?: number;
}

/**
 * Build and register the compact-window pre_compact hook.
 *
 * @param lifecycle  The Lifecycle instance to register on.
 * @param deps       Dependencies: llm provider + budget config.
 */
export function registerCompactWindowHook(
  lifecycle: Lifecycle,
  deps: CompactWindowHookDeps,
): void {
  lifecycle.on("pre_compact", "compact-window", async (payload: PreCompactPayload) => {
    const { messages } = payload;
    const budget = deps.tokenBudget;
    const fraction = deps.triggerFraction ?? 0.60;

    if (!shouldCompact(messages, budget, fraction)) {
      return;
    }

    const compacted = await compact(messages, {
      tokenBudget: budget,
      triggerFraction: fraction,
      llm: deps.llm,
    });

    // Mutate the messages array in-place so the harness sees the change.
    messages.splice(0, messages.length, ...compacted);
  });
}
