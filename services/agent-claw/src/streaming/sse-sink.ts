// services/agent-claw/src/streaming/sse-sink.ts
//
// Adapter: turn a StreamSink (notification callbacks) into SSE writes
// (text/event-stream frames). Encapsulates the writeEvent + redactString
// pattern that previously lived inline in routes/chat.ts streaming loop.
//
// Text deltas are scrubbed in flight via redactString; replacements
// accumulate into the caller-owned redactionLog so the surrounding route
// can persist them to scratchpad before post_turn runs.
//
// Tool inputs/outputs are NOT redacted here — they're already validated by
// the tool's Zod schemas, and the redact-secrets post_turn hook handles
// the assistant's final text. Re-redacting tool payloads on the wire would
// mangle structured outputs (e.g., a SMILES inside a tool result) that the
// next iteration of the loop legitimately needs to see.

import type { FastifyReply } from "fastify";
import type { StreamSink, TodoSnapshot } from "../core/streaming-sink.js";
import { writeEvent } from "./sse.js";
import {
  redactString,
  type RedactReplacement,
} from "../core/hooks/redact-secrets.js";

/**
 * Build a StreamSink that writes SSE events to the given Fastify reply.
 *
 * `redactionLog` is a caller-owned accumulator: the route reads it after
 * runHarness returns to persist a `redact_log` entry to scratchpad with
 * scope="stream_delta".
 *
 * `sessionIdForAwaitingInput` is needed because the SSE wire schema for
 * the awaiting_user_input event includes the session id alongside the
 * question, but the StreamSink interface only carries the question. The
 * route knows the session id at construction time, so we capture it here.
 */
export function makeSseSink(
  reply: FastifyReply,
  redactionLog: RedactReplacement[],
  sessionIdForAwaitingInput?: string,
): StreamSink {
  return {
    onSession: (id: string) =>
      writeEvent(reply, { type: "session", session_id: id }),
    onTextDelta: (delta: string) => {
      const safe = redactString(delta, redactionLog);
      writeEvent(reply, { type: "text_delta", delta: safe });
    },
    onToolCall: (toolId: string, input: unknown) =>
      writeEvent(reply, { type: "tool_call", toolId, input }),
    onToolResult: (toolId: string, output: unknown) =>
      writeEvent(reply, { type: "tool_result", toolId, output }),
    onTodoUpdate: (todos: TodoSnapshot[]) =>
      writeEvent(reply, { type: "todo_update", todos }),
    onAwaitingUserInput: (question: string) => {
      // The SSE schema requires a session id on awaiting_user_input. If the
      // route didn't supply one (stateless turn), fall back to an empty
      // string — clients keying off session_id will simply not be able to
      // resume, which mirrors the pre-Phase-2B behaviour for stateless turns.
      writeEvent(reply, {
        type: "awaiting_user_input",
        session_id: sessionIdForAwaitingInput ?? "",
        question,
      });
    },
    onFinish: (
      reason: string,
      usage: { promptTokens: number; completionTokens: number },
    ) => writeEvent(reply, { type: "finish", finishReason: reason, usage }),
  };
}
