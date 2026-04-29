// SSE emission helpers used by the /api/chat handler.
//
// Collapses the four near-duplicate "static text completion" blocks that
// previously lived inline in the slash-shortcircuit branches of chat.ts
// (text_delta + finish + reply.raw.end()), and gives the route a single
// place to construct the various terminal-event shapes.
//
// The wire format itself lives in ../../streaming/sse.ts — this module is
// purely about call-site ergonomics for the chat route.

import type { FastifyReply } from "fastify";
import { setupSse, writeEvent } from "../../streaming/sse.js";

/**
 * Send a one-shot text completion: either as JSON `{text}` (non-streaming)
 * or as `setupSse → text_delta → finish → end` (streaming). Both branches
 * close the response; callers should `return` immediately after.
 *
 * The four pre-harness short-circuit branches in the legacy chat.ts each
 * inlined this exact pattern — collapse to a single helper here.
 */
export function sendStaticTextCompletion(
  reply: FastifyReply,
  doStream: boolean,
  text: string,
): void {
  if (!doStream) {
    void reply.send({ text });
    return;
  }
  setupSse(reply);
  writeEvent(reply, { type: "text_delta", delta: text });
  writeEvent(reply, {
    type: "finish",
    finishReason: "stop",
    usage: { promptTokens: 0, completionTokens: 0 },
  });
  reply.raw.end();
}

/**
 * Send the SSE `error` envelope and close the stream. The non-streaming
 * counterpart is `reply.code(500).send({ error: "internal" })` which the
 * route owns inline (different status code semantics).
 */
export function sendSseError(reply: FastifyReply, errorCode: string): void {
  setupSse(reply);
  writeEvent(reply, { type: "error", error: errorCode });
  reply.raw.end();
}
