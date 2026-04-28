// pre_compact hook: compact-window — Phase C.1 (revised in Phase 3)
//
// Fires at the pre_compact lifecycle point. As of Phase 3, the harness
// itself gates the dispatch on budget.shouldCompact() (model-reported
// usage >= compactionThreshold * maxPromptTokens), so by the time this
// hook runs the trigger decision is already made — the hook always
// performs compaction.
//
// The auto path (runHarness loop) and manual path (/compact slash) share
// this hook. The hook honours payload.custom_instructions when set so the
// user-supplied steering on the manual path reaches the summarizer.
//
// Action: replaces payload.messages in-place with the compacted window
// returned by the compactor (system prompt + synopsis + recent N=3
// messages). The harness reads from the same `messages` reference on the
// next iteration.

import type { PreCompactPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";
import type { LlmProvider } from "../../llm/provider.js";
import { compact } from "../compactor.js";

export interface CompactWindowHookDeps {
  /** LLM provider used for the synopsis call. */
  llm: LlmProvider;
  /**
   * Full token budget (AGENT_TOKEN_BUDGET). Forwarded to the compactor for
   * its internal book-keeping; the trigger decision lives on Budget now.
   */
  tokenBudget: number;
  /**
   * Trigger fraction (default 0.60). Kept for parity with Budget's
   * compactionThreshold so /compact and the auto path use the same shape;
   * the compactor itself no longer gates on this.
   */
  triggerFraction?: number;
  /** How many recent messages to preserve verbatim. Default 3. */
  keepRecent?: number;
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
    const compacted = await compact(messages, {
      tokenBudget: deps.tokenBudget,
      triggerFraction: deps.triggerFraction ?? 0.60,
      recentKeep: deps.keepRecent ?? 3,
      llm: deps.llm,
      summaryInstructions: payload.custom_instructions ?? undefined,
    });

    // Mutate the messages array in-place so the harness sees the change.
    messages.splice(0, messages.length, ...compacted);
  });
}
