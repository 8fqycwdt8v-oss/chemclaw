// Streaming-path error classifier.
//
// Extracted from routes/chat.ts as part of the PR-6 god-file split.
// The streaming flow's catch arm distinguishes six error shapes so the
// SSE wire emits the right typed `error` event and the outer finally
// block sees the right `finishReason` for its session-end / cancelled /
// terminal-finish gates.
//
// This module is pure — no shared state with the streaming flow other
// than the `reply` object (for the typed error event), the `conn` close
// flag (so a disconnected client doesn't trigger writes), and the
// request log. The caller assigns the returned `finishReason` into its
// outer-scope `let` so the finally block reads it.
//
// Six classified shapes:
//
//   SessionBudgetExceededError → finishReason="session_budget_exceeded"
//                                + emits typed error event
//   BudgetExceededError        → finishReason="budget_exceeded"
//                                + emits typed error event
//   OptimisticLockError        → finishReason="concurrent_modification"
//                                + emits typed error event
//   AwaitingUserInputError     → finishReason="awaiting_user_input"
//                                NO error event (the finally lifts
//                                the awaiting_question from scratchpad
//                                and emits awaiting_user_input)
//   AbortLikeError | req.signal.aborted
//                              → finishReason="cancelled"
//                                NO error event (the finally emits the
//                                terminal `cancelled` event)
//   <generic>                  → finishReason unchanged from caller's
//                                default ("stop")
//                                + emits generic "internal" error event

import type { FastifyReply, FastifyRequest } from "fastify";
import {
  BudgetExceededError,
  SessionBudgetExceededError,
} from "../core/budget.js";
import { OptimisticLockError } from "../core/session-store.js";
import { AwaitingUserInputError } from "../tools/builtins/ask_user.js";
import { writeEvent } from "../streaming/sse.js";
import { isAbortLikeError } from "./chat-helpers.js";

export type StreamFinishReason =
  | "stop"
  | "session_budget_exceeded"
  | "budget_exceeded"
  | "concurrent_modification"
  | "awaiting_user_input"
  | "cancelled";

export interface ClassifiedStreamError {
  /** finishReason the outer-scope `let` should be assigned to. When
   *  undefined the caller leaves its default (`"stop"`) — that's the
   *  generic-error case where an "internal" error event was already
   *  emitted but the outer finally still fires session_end. */
  finishReason: StreamFinishReason | undefined;
}

/**
 * Classify a thrown error from the streaming flow's try block. Emits
 * the typed SSE error event for the four cases that warrant one
 * (SessionBudget / Budget / OptimisticLock / generic), logs at the
 * appropriate level, and returns the finishReason the caller must
 * assign into its outer-scope `let`.
 */
export function classifyStreamError(
  err: unknown,
  conn: { closed: boolean },
  reply: FastifyReply,
  req: FastifyRequest,
): ClassifiedStreamError {
  // Distinguish typed control-flow / quota errors so clients can render
  // appropriate UI. instanceof checks instead of err.name strings —
  // safer under minification and rename refactors.
  if (err instanceof SessionBudgetExceededError) {
    req.log.warn({ err }, "chat stream stopped: session budget exceeded");
    if (!conn.closed) {
      writeEvent(reply, { type: "error", error: "session_budget_exceeded" });
    }
    return { finishReason: "session_budget_exceeded" };
  }
  if (err instanceof BudgetExceededError) {
    // Per-turn budget overrun. runHarness sets finishReason="budget_exceeded"
    // and re-throws so the route can render a typed error event. Before
    // Phase 2B this branch was unreachable because chat.ts checked the
    // step cap manually and the prompt-token cap path was caught by the
    // generic else below.
    req.log.warn({ err }, "chat stream stopped: per-turn budget exceeded");
    if (!conn.closed) {
      writeEvent(reply, { type: "error", error: "budget_exceeded" });
    }
    return { finishReason: "budget_exceeded" };
  }
  if (err instanceof OptimisticLockError) {
    req.log.warn({ err }, "chat stream stopped: concurrent modification");
    if (!conn.closed) {
      writeEvent(reply, { type: "error", error: "concurrent_modification" });
    }
    return { finishReason: "concurrent_modification" };
  }
  if (err instanceof AwaitingUserInputError) {
    // runHarness re-throws AwaitingUserInputError after dispatching
    // post_turn (which persists the awaiting_question to scratchpad).
    // Treat as a normal awaiting-input exit, NOT an error — the route's
    // finally block lifts the question from scratchpad and emits the
    // awaiting_user_input SSE event.
    return { finishReason: "awaiting_user_input" };
  }
  if (isAbortLikeError(err) || req.signal.aborted) {
    // Client disconnected mid-stream: harness threw an AbortError after
    // its post_turn ran. Treat as a clean exit so the finally block
    // persists scratchpad with finish_reason="cancelled" and emits the
    // terminal `cancelled` event (best-effort — socket may already be
    // gone, in which case the writeEvent silently no-ops).
    req.log.info(
      { err: err instanceof Error ? err.message : err },
      "chat stream cancelled by client",
    );
    return { finishReason: "cancelled" };
  }
  // Generic — log loudly, emit a typed `internal` event, leave the
  // caller's outer finishReason at its default ("stop"). The finally
  // block's session_end gate fires on stop, which is the existing
  // contract; widening that decision to "treat unknown errors as a
  // distinct finishReason" is a separate change.
  req.log.error({ err }, "chat stream failed");
  if (!conn.closed) {
    writeEvent(reply, { type: "error", error: "internal" });
  }
  return { finishReason: undefined };
}
