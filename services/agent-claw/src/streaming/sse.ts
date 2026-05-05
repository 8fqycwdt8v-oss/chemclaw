// Shared SSE primitives used by /api/chat, /api/deep_research, and
// /api/chat/plan/approve. The wire format is part of the public contract
// with any SSE-consuming client (the future frontend repo, the in-tree
// CLI at tools/cli/, external integrations), so changes here are
// versioning-relevant.
//
// Event taxonomy (discriminated by `type`):
//   text_delta          — incremental assistant text
//   tool_call           — tool invocation about to happen
//   tool_result         — tool returned (output may be redacted/truncated)
//   plan_step           — single step from /plan-mode JSON plan
//   plan_ready          — plan saved; client can POST /approve|/reject
//   session             — emitted once per turn so clients can resume
//   todo_update         — manage_todos changed the todo list
//   awaiting_user_input — model asked a question via ask_user
//   cancelled           — terminal: client disconnected mid-stream and the
//                         harness loop bailed out cleanly. Best-effort —
//                         emitted only when the socket is still writable
//                         after the abort, otherwise the route silently
//                         persists `finish_reason=cancelled` and ends.
//   finish              — terminal: stream successfully ended
//   error               — terminal: stream failed (always pair with finish-equivalent)
//
// SSE framing rule: a literal "\n" inside a `data:` line terminates the
// event, so newlines in payload JSON must be escaped to "\\n" before the
// wire write. `writeEvent` does this once, here, instead of every caller
// remembering to.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { PlanStep } from "../core/plan-mode.js";

import { getLogger } from "../observability/logger.js";

export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; toolId: string; input: unknown }
  | { type: "tool_result"; toolId: string; output: unknown }
  | { type: "plan_step"; step_number: number; tool: string; args: unknown; rationale: string }
  | { type: "plan_ready"; plan_id: string; steps: PlanStep[]; created_at: number }
  | { type: "session"; session_id: string }
  | { type: "todo_update"; todos: Array<{ id: string; ordering: number; content: string; status: string }> }
  | { type: "awaiting_user_input"; session_id: string; question: string }
  | { type: "cancelled"; session_id?: string }
  | { type: "finish"; finishReason: string; usage: { promptTokens: number; completionTokens: number } }
  // Error frame is additive: `error` remains the legacy code string so
  // existing CLI / clients keep parsing it, with optional `trace_id`
  // and `request_id` siblings so a streaming failure can be linked
  // back to a Langfuse trace + Loki log line.
  | { type: "error"; error: string; trace_id?: string; request_id?: string };

export function writeEvent(reply: FastifyReply, payload: StreamEvent): void {
  // Guard against post-end writes: Node's OutgoingMessage.write() after
  // end() does NOT throw synchronously — it returns false and emits an
  // async `error` event for ERR_STREAM_WRITE_AFTER_END. Callers that wrap
  // writeEvent in try/catch (chat-streaming-sse.ts, chat-plan-mode.ts)
  // cannot catch that async event. Cycle-2 review caught this on the
  // plan-mode path where the helper's inner finally calls reply.raw.end()
  // and the route's outer finally still runs emitTerminalEvents.
  if (reply.raw.writableEnded) return;
  const json = JSON.stringify(payload).replace(/\r?\n/g, "\\n");
  // Note: an ECONNRESET on a closed socket throws synchronously here.
  // Surface a structured warning so an intermittent client disconnect is
  // observable but doesn't bubble up and crash the route.
  try {
    reply.raw.write(`data: ${json}\n\n`);
  } catch (err) {
    getLogger("agent-claw.sse").warn(
      {
        event: "sse_write_failed",
        sse_event_type: payload.type,
        err_name: (err as Error).name,
        err_msg: (err as Error).message,
      },
      "SSE writeEvent threw — client likely disconnected",
    );
  }
}

export function setupSse(reply: FastifyReply): void {
  reply.raw.statusCode = 200;
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.hijack();
}

/**
 * Track upstream disconnects so the streaming loop can short-circuit
 * `writeEvent` calls after the client goes away.
 *
 * Listens on BOTH `close` and `aborted` — Node emits `aborted` for
 * HTTP/1.0-style mid-stream resets that don't always trigger `close`.
 * Three SSE routes (chat.ts, plan.ts, deep-research.ts) previously
 * inlined the same handler shape; plan.ts in particular missed the
 * `aborted` listener. Centralising here keeps the listener pair
 * symmetric.
 */
export function trackConnection(req: FastifyRequest): { closed: boolean } {
  const conn = { closed: false };
  const onClose = () => {
    conn.closed = true;
  };
  req.raw.on("close", onClose);
  req.raw.on("aborted", onClose);
  return conn;
}
