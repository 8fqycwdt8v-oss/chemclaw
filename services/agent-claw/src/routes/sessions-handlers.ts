// Route handler bodies for /api/sessions/* and /api/internal/sessions/*.
//
// Extracted from routes/sessions.ts as part of the PR-6 god-file split.
// Each handler is an async function that takes the explicit (req, reply,
// deps) triple and writes the reply directly. The wiring layer in
// routes/sessions.ts binds these into Fastify route registrations.
//
// The two resume handlers share `executeResume` so the common
// "increment-or-409" + "build-continue-message" + "runChainedHarness"
// pipeline is in one place; only the user-source differs (header vs JWT).

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PaperclipClient } from "../core/paperclip-client.js";
import {
  loadSession,
  tryIncrementAutoResumeCount,
} from "../core/session-store.js";
import {
  loadActivePlanForSession,
  advancePlan,
} from "../core/plan-store-db.js";
import { withUserContext } from "../db/with-user-context.js";
import { runChainedHarness } from "../core/chained-harness.js";
import { verifyBearerHeader, McpAuthError } from "../security/mcp-tokens.js";
import type { Message } from "../core/types.js";

const UUID_RE = /^[0-9a-f-]{36}$/i;

// Continue prompt used by both resume endpoints. Kept short + boring so
// it doesn't influence the model's reasoning beyond "continue the plan
// you already have."
const RESUME_CONTINUE_MESSAGES: Message[] = [
  { role: "user", content: "Continue with the next step on your todo list. If everything is done, summarize and stop." },
];

interface ReadDeps {
  pool: Pool;
  getUser: (req: FastifyRequest) => string;
}

interface HarnessDeps extends ReadDeps {
  config?: Config;
  llm?: LlmProvider;
  registry?: ToolRegistry;
  paperclip?: PaperclipClient;
}

// ---------------------------------------------------------------------------
// GET /api/sessions/:id — session status.
// ---------------------------------------------------------------------------

export async function handleGetSession(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
  deps: ReadDeps,
): Promise<unknown> {
  const user = deps.getUser(req);
  const sessionId = req.params.id;
  if (!UUID_RE.test(sessionId)) {
    return await reply.code(400).send({ error: "invalid_input", detail: "session id must be a UUID" });
  }
  const state = await loadSession(deps.pool, user, sessionId);
  if (!state) {
    return await reply.code(404).send({ error: "not_found" });
  }
  return await reply.code(200).send({
    session_id: state.id,
    todos: state.todos.map((t) => ({
      id: t.id,
      ordering: t.ordering,
      content: t.content,
      status: t.status,
    })),
    awaiting_question: state.awaitingQuestion,
    last_finish_reason: state.lastFinishReason,
    message_count: state.messageCount,
    created_at: state.createdAt.toISOString(),
    updated_at: state.updatedAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// GET /api/sessions — list calling user's recent sessions.
// Paged via ?limit (default 20, max 100). Returns id + summary fields only.
// ---------------------------------------------------------------------------

export async function handleListSessions(
  req: FastifyRequest<{ Querystring: { limit?: string } }>,
  reply: FastifyReply,
  deps: ReadDeps,
): Promise<unknown> {
  const user = deps.getUser(req);
  const rawLimit = parseInt(req.query.limit ?? "20", 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 20;

  const rows = await withUserContext(deps.pool, user, (client) =>
    client
      .query<{
        id: string;
        last_finish_reason: string | null;
        awaiting_question: string | null;
        message_count: number;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id::text AS id,
                last_finish_reason,
                awaiting_question,
                message_count,
                created_at,
                updated_at
           FROM agent_sessions
          ORDER BY updated_at DESC
          LIMIT $1`,
        [limit],
      )
      .then((r) => r.rows),
  );

  return await reply.code(200).send({
    sessions: rows.map((r) => ({
      session_id: r.id,
      last_finish_reason: r.last_finish_reason,
      awaiting_question: r.awaiting_question,
      message_count: r.message_count,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
    })),
  });
}

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/plan/run — Phase E chained execution.
//
// Loads the most-recent active plan for the session and runs harness
// turns until the plan is completed, max_steps is hit, the auto-chain
// cap fires, or the session-budget trips. Each turn appends to the
// session's message history. Returns the final state.
// ---------------------------------------------------------------------------

export async function handlePlanRun(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
  deps: HarnessDeps,
): Promise<unknown> {
  if (!deps.config || !deps.llm || !deps.registry) {
    return await reply.code(500).send({ error: "harness_deps_missing" });
  }
  const cfg = deps.config;
  const llm = deps.llm;
  const registry = deps.registry;

  const user = deps.getUser(req);
  const sessionId = req.params.id;
  if (!UUID_RE.test(sessionId)) {
    return await reply.code(400).send({ error: "invalid_input", detail: "session id must be a UUID" });
  }
  const plan = await loadActivePlanForSession(deps.pool, user, sessionId);
  if (!plan) {
    return await reply.code(404).send({ error: "no_active_plan" });
  }

  await advancePlan(deps.pool, user, plan.id, { status: "running" });

  const result = await runChainedHarness({
    pool: deps.pool,
    user,
    sessionId,
    messages: plan.initialMessages,
    cfg,
    llm,
    registry,
    paperclip: deps.paperclip,
    log: req.log,
    signal: req.signal,
    // Phase F4: pass the plan so the runner can advance current_step_index
    // as tool calls match planned steps.
    planForProgress: {
      id: plan.id,
      steps: plan.steps,
      initialIndex: plan.currentStepIndex,
    },
  });

  // Mark plan as completed if the harness reported "stop", otherwise leave
  // it running for the next iteration.
  const finalIndex = result.planFinalStepIndex ?? plan.currentStepIndex;
  if (result.finalFinishReason === "stop") {
    // If we actually walked to the last step, mark completed; otherwise
    // the model "stopped" early — keep it running for a future call.
    const status = finalIndex >= plan.steps.length ? "completed" : "running";
    await advancePlan(deps.pool, user, plan.id, {
      currentStepIndex: finalIndex,
      status,
    });
  } else if (result.finalFinishReason === "session_budget_exceeded") {
    await advancePlan(deps.pool, user, plan.id, {
      currentStepIndex: finalIndex,
      status: "failed",
    });
  } else {
    // max_steps / awaiting_user_input / etc — persist progress, keep open.
    await advancePlan(deps.pool, user, plan.id, { currentStepIndex: finalIndex });
  }

  return await reply.code(200).send({
    plan_id: plan.id,
    session_id: sessionId,
    auto_turns_used: result.autoTurns,
    final_finish_reason: result.finalFinishReason,
    total_steps_used: result.totalSteps,
    // Plan progress info — clients render this as a "X of N steps" badge.
    plan_progress: {
      current_step_index: finalIndex,
      total_steps: plan.steps.length,
    },
  });
}

// ---------------------------------------------------------------------------
// Shared resume execution.
//
// Both POST /api/sessions/:id/resume and POST /api/internal/sessions/:id/resume
// share the same:
//   1. atomic auto_resume_count increment (with cap + awaiting guard)
//   2. precise-409 reason readback
//   3. continue-prompt construction
//   4. runChainedHarness call with maxAutoTurns=1
//   5. response shape
//
// They differ only in user identity source (x-user-entra-id header for the
// public route; signed JWT claim for the internal route). Once the user
// has been determined, this function does the rest.
// ---------------------------------------------------------------------------

async function executeResume(
  user: string,
  sessionId: string,
  req: FastifyRequest,
  reply: FastifyReply,
  cfg: Config,
  llm: LlmProvider,
  registry: ToolRegistry,
  pool: Pool,
  paperclip: PaperclipClient | undefined,
): Promise<unknown> {
  // Atomic counter + cap + awaiting check. Doing this BEFORE the harness
  // run means:
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
      return await reply.code(404).send({ error: "not_found" });
    }
    if (after.lastFinishReason === "awaiting_user_input") {
      return await reply.code(409).send({
        error: "awaiting_user_input",
        detail: "session is paused on a clarifying question; needs a real user reply",
      });
    }
    return await reply.code(409).send({
      error: "auto_resume_cap_reached",
      cap: after.autoResumeCap,
    });
  }

  const result = await runChainedHarness({
    pool,
    user,
    sessionId,
    messages: RESUME_CONTINUE_MESSAGES,
    cfg,
    llm,
    registry,
    paperclip,
    log: req.log,
    signal: req.signal,
    maxAutoTurns: 1, // resume is one turn at a time; cron can call again
  });

  return await reply.code(200).send({
    session_id: sessionId,
    final_finish_reason: result.finalFinishReason,
    total_steps_used: result.totalSteps,
    auto_resume_count: newCount,
  });
}

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/resume — Phase I auto-resume (header-authed).
//
// Runs ONE more harness turn with a synthetic "Continue with the next
// step on your todo list." user message. Used by the session_reanimator
// cron to keep stalled sessions making progress without user interaction.
//
// Refuses when:
//   - session.last_finish_reason = 'awaiting_user_input' (needs a real human)
//   - session.auto_resume_count >= session.auto_resume_cap (loop guard)
//   - session-budget tripped
//
// No admin gate here yet — operators control access via the cron's own
// service role and an internal-only listener; if we expose this publicly
// it'll need an `admin` role check via withUserContext.
// ---------------------------------------------------------------------------

export async function handleResume(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
  deps: HarnessDeps,
): Promise<unknown> {
  if (!deps.config || !deps.llm || !deps.registry) {
    return await reply.code(500).send({ error: "harness_deps_missing" });
  }
  const user = deps.getUser(req);
  const sessionId = req.params.id;
  if (!UUID_RE.test(sessionId)) {
    return await reply.code(400).send({ error: "invalid_input", detail: "session id must be a UUID" });
  }
  const state = await loadSession(deps.pool, user, sessionId);
  if (!state) {
    return await reply.code(404).send({ error: "not_found" });
  }
  return await executeResume(
    user,
    sessionId,
    req,
    reply,
    deps.config,
    deps.llm,
    deps.registry,
    deps.pool,
    deps.paperclip,
  );
}

// ---------------------------------------------------------------------------
// POST /api/internal/sessions/:id/resume — JWT-authenticated auto-resume.
//
// The reanimator daemon (services/optimizer/session_reanimator/) calls
// this with a Bearer JWT signed by MCP_AUTH_SIGNING_KEY. The token's
// `user` claim names the session's owning user — that becomes the RLS
// scope for this turn. No header trust: we read user identity from the
// signed claims, not from x-user-entra-id.
//
// Required scope: "agent:resume". Other internal callers can be added
// later by minting tokens with different scopes (e.g. "agent:summarize"
// for a future summary daemon).
// ---------------------------------------------------------------------------

export async function handleInternalResume(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
  deps: HarnessDeps,
): Promise<unknown> {
  if (!deps.config || !deps.llm || !deps.registry) {
    return await reply.code(500).send({ error: "harness_deps_missing" });
  }

  // Verify the JWT.
  const authz = req.headers.authorization;
  let claimedUser: string;
  try {
    const claims = verifyBearerHeader(typeof authz === "string" ? authz : undefined, {
      requiredScope: "agent:resume",
    });
    if (!claims) {
      return await reply.code(401).send({
        error: "unauthenticated",
        detail: "Authorization: Bearer <jwt> required",
      });
    }
    claimedUser = claims.user;
  } catch (err) {
    if (err instanceof McpAuthError) {
      return await reply.code(401).send({
        error: "unauthenticated",
        detail: err.message,
      });
    }
    throw err;
  }

  const sessionId = req.params.id;
  if (!UUID_RE.test(sessionId)) {
    return await reply.code(400).send({ error: "invalid_input", detail: "session id must be a UUID" });
  }
  return await executeResume(
    claimedUser,
    sessionId,
    req,
    reply,
    deps.config,
    deps.llm,
    deps.registry,
    deps.pool,
    deps.paperclip,
  );
}
