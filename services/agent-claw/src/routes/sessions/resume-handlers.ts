// POST /api/sessions/:id/resume          (header-trust auto-resume)
// POST /api/internal/sessions/:id/resume (JWT-trust auto-resume — reanimator daemon)
//
// Both handlers share all of the post-`tryIncrementAutoResumeCount` logic.
// The legacy routes/sessions.ts file inlined it twice (44 LOC each, near
// verbatim); this module consolidates into `_runResumeForUser`. The split
// between the two public handlers is purely about user-identity sourcing:
//   - public route reads from `getUser(req)` (header trust)
//   - internal route reads from the verified JWT claims (no header trust)

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Config } from "../../config.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { PaperclipClient } from "../../core/paperclip-client.js";
import { runChainedHarness } from "../../core/chained-harness.js";
import {
  loadSession,
  tryIncrementAutoResumeCount,
} from "../../core/session-store.js";
import { verifyBearerHeader, McpAuthError } from "../../security/mcp-tokens.js";
import type { Message } from "../../core/types.js";

/**
 * The synthetic user message that the reanimator + public-resume handlers
 * feed to the harness. Kept short + boring so it doesn't influence the
 * model's reasoning beyond "continue the plan you already have." Both
 * resume routes use the verbatim same string.
 */
const RESUME_CONTINUE_PROMPT =
  "Continue with the next step on your todo list. If everything is done, summarize and stop.";

export interface ResumeHandlersDeps {
  pool: Pool;
  config?: Config;
  llm?: LlmProvider;
  registry?: ToolRegistry;
  paperclip?: PaperclipClient;
  getUser: (req: FastifyRequest) => string;
}

/**
 * Shared post-increment body. Runs after the SQL-atomic counter bump
 * (`tryIncrementAutoResumeCount`) returned a fresh count or null. When
 * null, the call is refused with a precise reason; otherwise one chained
 * harness turn fires and the result is returned.
 */
async function _runResumeForUser(
  req: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
  user: string,
  deps: ResumeHandlersDeps,
): Promise<void> {
  if (!deps.config || !deps.llm || !deps.registry) {
    void reply.code(500).send({ error: "harness_deps_missing" });
    return;
  }
  const cfg = deps.config;
  const llm = deps.llm;
  const registry = deps.registry;
  const pool = deps.pool;

  // Atomic counter increment + cap check + awaiting-user-input guard.
  // Doing this BEFORE the harness run means:
  //   - Two parallel reanimator calls can't both pass the cap check
  //   - A crash mid-harness still leaves the count bumped (the next tick
  //     sees the correct value rather than re-firing)
  //   - The awaiting_user_input check is enforced in SQL, not JS
  const newCount = await tryIncrementAutoResumeCount(pool, user, sessionId);
  if (newCount === null) {
    // Either cap reached, awaiting_user_input set, or row missing — read
    // the row again to give a precise reason to the caller.
    const after = await loadSession(pool, user, sessionId);
    if (!after) {
      void reply.code(404).send({ error: "not_found" });
      return;
    }
    if (after.lastFinishReason === "awaiting_user_input") {
      void reply.code(409).send({
        error: "awaiting_user_input",
        detail: "session is paused on a clarifying question; needs a real user reply",
      });
      return;
    }
    void reply.code(409).send({
      error: "auto_resume_cap_reached",
      cap: after.autoResumeCap,
    });
    return;
  }

  const continueMessages: Message[] = [
    { role: "user", content: RESUME_CONTINUE_PROMPT },
  ];

  const result = await runChainedHarness({
    pool,
    user,
    sessionId,
    messages: continueMessages,
    cfg,
    llm,
    registry,
    paperclip: deps.paperclip,
    log: req.log,
    maxAutoTurns: 1, // resume is one turn at a time; cron can call again
  });

  void reply.code(200).send({
    session_id: sessionId,
    final_finish_reason: result.finalFinishReason,
    total_steps_used: result.totalSteps,
    auto_resume_count: newCount,
  });
}

/**
 * POST /api/sessions/:id/resume — Phase I auto-resume.
 *
 * Runs ONE more harness turn with a synthetic "Continue with the next
 * step on your todo list." user message. Used by the session_reanimator
 * cron to keep stalled sessions making progress without user interaction.
 *
 * Refuses when:
 *   - session.last_finish_reason = 'awaiting_user_input' (needs a real human)
 *   - session.auto_resume_count >= session.auto_resume_cap (loop guard)
 *   - session-budget tripped
 *
 * No admin gate here yet — operators control access via the cron's own
 * service role and an internal-only listener; if we expose this publicly
 * it'll need an `admin` role check via withUserContext.
 */
export async function handleResume(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
  deps: ResumeHandlersDeps,
): Promise<void> {
  if (!deps.config || !deps.llm || !deps.registry) {
    void reply.code(500).send({ error: "harness_deps_missing" });
    return;
  }
  const user = deps.getUser(req);
  const sessionId = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    void reply.code(400).send({ error: "invalid_input", detail: "session id must be a UUID" });
    return;
  }
  const state = await loadSession(deps.pool, user, sessionId);
  if (!state) {
    void reply.code(404).send({ error: "not_found" });
    return;
  }
  await _runResumeForUser(req, reply, sessionId, user, deps);
}

/**
 * POST /api/internal/sessions/:id/resume — JWT-authenticated auto-resume.
 *
 * The reanimator daemon (services/optimizer/session_reanimator/) calls
 * this with a Bearer JWT signed by MCP_AUTH_SIGNING_KEY. The token's
 * `user` claim names the session's owning user — that becomes the RLS
 * scope for this turn. No header trust: we read user identity from the
 * signed claims, not from x-user-entra-id.
 *
 * Required scope: "agent:resume". Other internal callers can be added
 * later by minting tokens with different scopes (e.g. "agent:summarize"
 * for a future summary daemon).
 */
export async function handleInternalResume(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
  deps: ResumeHandlersDeps,
): Promise<void> {
  if (!deps.config || !deps.llm || !deps.registry) {
    void reply.code(500).send({ error: "harness_deps_missing" });
    return;
  }

  // Verify the JWT.
  const authz = req.headers["authorization"];
  let claimedUser: string;
  try {
    const claims = verifyBearerHeader(typeof authz === "string" ? authz : undefined, {
      requiredScope: "agent:resume",
    });
    if (!claims) {
      void reply.code(401).send({
        error: "unauthenticated",
        detail: "Authorization: Bearer <jwt> required",
      });
      return;
    }
    claimedUser = claims.user;
  } catch (err) {
    if (err instanceof McpAuthError) {
      void reply.code(401).send({
        error: "unauthenticated",
        detail: err.message,
      });
      return;
    }
    throw err;
  }

  const sessionId = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    void reply.code(400).send({ error: "invalid_input", detail: "session id must be a UUID" });
    return;
  }
  await _runResumeForUser(req, reply, sessionId, claimedUser, deps);
}
