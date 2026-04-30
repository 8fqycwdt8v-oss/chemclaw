// Slash-command short-circuit handler for the chat route.
//
// Handles the slash verbs that don't need an LLM call (so they can return
// before the harness path even starts):
//
//   /help       — static help text
//   /skills     — list available skill packs
//   /feedback   — record a thumbs-up/down with a reason in feedback_events
//   /check      — environment / config sanity report
//   /learn      — placeholder for the future learn flow
//   <unknown>   — friendly "Unknown command, try /help" fallback
//
// Returns true when the request was handled (caller must return), false
// when the request needs the harness path. Extracted from routes/chat.ts
// in PR-6.

import type { FastifyReply, FastifyRequest } from "fastify";
import { parseFeedbackArgs, shortCircuitResponse, HELP_TEXT } from "../core/slash.js";
import { setupSse, writeEvent } from "../streaming/sse.js";
import { recordFeedback, type ChatRouteDeps, type ChatRequest } from "./chat-helpers.js";

const SHORT_CIRCUIT_VERBS = new Set(["help", "skills", "feedback", "check", "learn"]);

interface SlashShortCircuitInput {
  verb: string;
  args: string;
  isStreamable: boolean;
}

/**
 * If the parsed slash result is a short-circuit verb, write the response
 * (streaming or JSON) and return true. Otherwise return false so the
 * caller proceeds with the harness path.
 */
export async function handleSlashShortCircuit(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ChatRouteDeps,
  body: ChatRequest,
  user: string,
  slashResult: SlashShortCircuitInput,
  doStream: boolean,
): Promise<boolean> {
  if (slashResult.isStreamable || slashResult.verb === "") {
    return false;
  }
  const verb = slashResult.verb;

  // Unknown verb.
  if (!SHORT_CIRCUIT_VERBS.has(verb)) {
    sendShortText(reply, doStream, `Unknown command /${verb}. Try /help.`);
    return true;
  }

  // /feedback — needs DB write.
  if (verb === "feedback") {
    const fbArgs = parseFeedbackArgs(slashResult.args);
    if (!fbArgs) {
      sendShortText(
        reply,
        doStream,
        `Invalid /feedback syntax. Usage: /feedback up|down "reason"`,
      );
      return true;
    }
    try {
      await recordFeedback(
        deps.pool,
        user,
        fbArgs.signal,
        fbArgs.reason,
        body.agent_trace_id,
      );
      sendShortText(reply, doStream, `Thanks for your feedback (${fbArgs.signal}).`);
      return true;
    } catch (err) {
      req.log.error({ err }, "feedback write failed");
      if (!doStream) {
        await reply.code(500).send({ error: "internal" });
      } else {
        setupSse(reply);
        writeEvent(reply, { type: "error", error: "feedback_write_failed" });
        reply.raw.end();
      }
      return true;
    }
  }

  // Other short-circuit verbs (/help, /skills, /check, /learn).
  const text = shortCircuitResponse(verb) ?? HELP_TEXT;
  sendShortText(reply, doStream, text);
  return true;
}

/**
 * Helper that sends a single-shot text response in either JSON or
 * SSE-streaming form, ending the stream with a clean `finish` event.
 */
function sendShortText(reply: FastifyReply, doStream: boolean, text: string): void {
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
