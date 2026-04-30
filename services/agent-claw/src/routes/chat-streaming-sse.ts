// Terminal-event emitter for the streaming chat path.
//
// Extracted from routes/chat.ts as part of the PR-6 god-file split
// (priority 3 in the code-reviewer agent's recommended ordering: the
// `cancelled` and `finish` events are an inseparable pair — the
// cancelled event must fire BEFORE the terminal finish so a buffering
// SSE proxy or a slow-to-disconnect client sees both signals).
//
// Both emits are best-effort — if the socket is already gone the
// writeEvent throws and we silently swallow it. The route's outer
// finally still runs reply.raw.end() so the response is closed
// regardless.

import type { FastifyReply } from "fastify";
import { writeEvent } from "../streaming/sse.js";
import type { Budget } from "../core/budget.js";

export interface EmitTerminalEventsInput {
  reply: FastifyReply;
  conn: { closed: boolean };
  finishReason: string;
  /** May be undefined if the harness path threw before the budget was
   *  built (e.g. a hook denied the turn at pre_turn). The fallback
   *  zero-token usage shape preserves the prior inline behaviour. */
  budget: Budget | undefined;
  sessionId: string | null;
}

/**
 * Emit the `cancelled` event (when finishReason === "cancelled") and
 * the terminal `finish` event for the streaming flow. Both are gated
 * on `!conn.closed` so a disconnected client doesn't trigger writes.
 *
 * Order is load-bearing: cancelled fires BEFORE finish so a buffering
 * SSE proxy (or any future intermediary that holds the last few
 * frames) shows both signals to the consumer.
 */
export function emitTerminalEvents(input: EmitTerminalEventsInput): void {
  // Emit the `cancelled` event BEFORE the terminal `finish` so a
  // disconnecting client (or any future SSE proxy that buffers the last
  // few frames) sees both signals: the cancellation marker and the
  // standard terminal frame. Best-effort — if the socket is already
  // gone the writes silently fail and the route falls through to
  // reply.raw.end(). When a peer truly drops there is nothing for the
  // event to land on; the cancellation is recorded in the DB
  // (last_finish_reason='cancelled') for the next session load.
  if (input.finishReason === "cancelled" && !input.conn.closed) {
    try {
      writeEvent(input.reply, {
        type: "cancelled",
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
      });
    } catch {
      // socket already gone
    }
  }

  if (!input.conn.closed) {
    try {
      writeEvent(input.reply, {
        type: "finish",
        finishReason: input.finishReason,
        usage: input.budget?.summary() ?? { promptTokens: 0, completionTokens: 0 },
      });
    } catch {
      // socket already gone
    }
  }
}
