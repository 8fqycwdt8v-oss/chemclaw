// Slash short-circuit verbs for /api/chat.
//
// Handles the pre-harness verbs that don't need the LLM: /help, /skills,
// /check, /learn, /feedback. These are dispatched after slash parsing and
// before any session / harness work. Each path emits a single static text
// completion via sendStaticTextCompletion() and returns true; the caller
// returns immediately.
//
// /feedback is the only path that touches the DB — it writes a row to
// feedback_events under the user's RLS scope.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { withUserContext } from "../../db/with-user-context.js";
import {
  parseFeedbackArgs,
  shortCircuitResponse,
  HELP_TEXT,
  type SlashParseResult,
} from "../../core/slash.js";
import { sendStaticTextCompletion, sendSseError } from "./sse-stream.js";

/**
 * Insert a feedback row under the user's RLS scope. Used by the /feedback
 * slash verb so the agent can record a thumbs-up / thumbs-down + reason
 * against the assistant turn that produced the reply.
 */
async function writeFeedback(
  pool: Pool,
  userEntraId: string,
  signal: string,
  reason: string,
  traceId: string | undefined,
): Promise<void> {
  await withUserContext(pool, userEntraId, async (client) => {
    await client.query(
      `INSERT INTO feedback_events (user_entra_id, signal, query_text, trace_id)
       VALUES ($1, $2, $3, $4)`,
      [userEntraId, signal, reason || null, traceId || null],
    );
  });
}

export interface SlashShortCircuitDeps {
  pool: Pool;
}

/**
 * Try to handle a non-streamable slash verb. Returns `true` when the verb
 * was handled (the caller MUST return immediately — the response is closed),
 * `false` to fall through to the harness path.
 */
export async function tryHandleShortCircuitSlash(
  req: FastifyRequest,
  reply: FastifyReply,
  slashResult: SlashParseResult,
  doStream: boolean,
  user: string,
  agentTraceId: string | undefined,
  deps: SlashShortCircuitDeps,
): Promise<boolean> {
  // Only fires for non-streamable verbs (the harness path consumes streamable
  // verbs like /plan and /compact). Empty verb means "no slash command".
  if (slashResult.isStreamable || slashResult.verb === "") {
    return false;
  }

  const verb = slashResult.verb;

  // Unknown verb — emit a help nudge and stop.
  if (!["help", "skills", "feedback", "check", "learn"].includes(verb)) {
    sendStaticTextCompletion(reply, doStream, `Unknown command /${verb}. Try /help.`);
    return true;
  }

  // /feedback — needs DB write.
  if (verb === "feedback") {
    const fbArgs = parseFeedbackArgs(slashResult.args);
    if (!fbArgs) {
      sendStaticTextCompletion(
        reply,
        doStream,
        `Invalid /feedback syntax. Usage: /feedback up|down "reason"`,
      );
      return true;
    }
    try {
      await writeFeedback(deps.pool, user, fbArgs.signal, fbArgs.reason, agentTraceId);
      sendStaticTextCompletion(reply, doStream, `Thanks for your feedback (${fbArgs.signal}).`);
      return true;
    } catch (err) {
      req.log.error({ err }, "feedback write failed");
      if (!doStream) {
        void reply.code(500).send({ error: "internal" });
        return true;
      }
      sendSseError(reply, "feedback_write_failed");
      return true;
    }
  }

  // Other short-circuit verbs (/help, /skills, /check, /learn).
  const text = shortCircuitResponse(verb) ?? HELP_TEXT;
  sendStaticTextCompletion(reply, doStream, text);
  return true;
}
