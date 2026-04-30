// Manual /compact slash dispatcher.
//
// Extracted from routes/chat.ts. The user can run /compact mid-conversation
// to force the compact-window hook to summarize the message window before
// the next harness turn. This module owns the pre_compact + post_compact
// dispatch pair (with trigger="manual"), mutates `messages` in place via
// the hook, and absorbs any hook-side errors so a compaction failure
// doesn't abort the turn.

import type { FastifyBaseLogger } from "fastify";
import type { Lifecycle } from "../core/lifecycle.js";
import { estimateTokenCount } from "../core/budget.js";
import type {
  Message,
  PostCompactPayload,
  PreCompactPayload,
  ToolContext,
} from "../core/types.js";

export async function dispatchManualCompact(
  lifecycle: Lifecycle,
  ctx: ToolContext,
  messages: Message[],
  customInstructions: string | null,
  log: FastifyBaseLogger,
): Promise<void> {
  const preTokens = estimateTokenCount(messages);
  const prePayload: PreCompactPayload = {
    ctx,
    messages,
    trigger: "manual",
    pre_tokens: preTokens,
    custom_instructions: customInstructions,
  };
  try {
    await lifecycle.dispatch("pre_compact", prePayload);
    const postTokens = estimateTokenCount(messages);
    const postPayload: PostCompactPayload = {
      ctx,
      trigger: "manual",
      pre_tokens: preTokens,
      post_tokens: postTokens,
    };
    await lifecycle.dispatch("post_compact", postPayload);
  } catch (err) {
    // Compaction itself shouldn't abort the turn — log and proceed with
    // the original message window.
    log.warn({ err }, "manual /compact dispatch failed; proceeding uncompacted");
  }
}
