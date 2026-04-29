// Session-scoped routes for /api/sessions/...
//
//   GET  /api/sessions/:id            — session status read
//   GET  /api/sessions                — list calling user's recent sessions
//   POST /api/sessions/:id/plan/run   — Phase E chained plan execution
//   POST /api/sessions/:id/resume     — Phase I auto-resume (header trust)
//   POST /api/internal/sessions/:id/resume — JWT-trust auto-resume (reanimator)
//
// The two GETs are short enough to live inline here. The mutating POSTs
// delegate to plan-handlers.ts and resume-handlers.ts. The chained-harness
// helper itself moved to core/chained-harness.ts in PR-6 — multi-turn
// orchestration is a core lifecycle, not a route concern.
//
// Used by client UIs to render progress (todos), resume affordances
// (awaiting_question), and a session picker. The plan/run + resume
// endpoints are the multi-hour-autonomy unlock — both run a harness turn
// without requiring a fresh user message.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Config } from "../../config.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import type { PaperclipClient } from "../../core/paperclip-client.js";
import { loadSession } from "../../core/session-store.js";
import { withUserContext } from "../../db/with-user-context.js";
import { handlePlanRun } from "./plan-handlers.js";
import { handleResume, handleInternalResume } from "./resume-handlers.js";

export interface SessionsRouteDeps {
  pool: Pool;
  getUser: (req: FastifyRequest) => string;
  // The chained-run + resume endpoints need the harness deps.
  config?: Config;
  llm?: LlmProvider;
  registry?: ToolRegistry;
  promptRegistry?: PromptRegistry;
  /** Paperclip-lite client. When supplied, every chained-harness iteration
   *  reserves and releases budget against the sidecar — without this, long
   *  auto-resume chains can blow past the daily USD cap with no 429.
   *  Mirrors the wiring in services/agent-claw/src/routes/chat. */
  paperclip?: PaperclipClient;
}

export function registerSessionsRoute(
  app: FastifyInstance,
  deps: SessionsRouteDeps,
): void {
  const { pool, getUser } = deps;

  // Per-route rate-limit config for the mutating session endpoints.
  // /plan/run can chain up to AGENT_PLAN_MAX_AUTO_TURNS harness iterations
  // per call, so we want a tighter cap than the global rate limit. Default
  // to 1/4 of the chat limit (e.g. 7/min if chat is 30/min).
  const sessionMutatingRateLimit = deps.config
    ? {
        config: {
          rateLimit: {
            max: Math.max(1, Math.floor(deps.config.AGENT_CHAT_RATE_LIMIT_MAX / 4)),
            timeWindow: deps.config.AGENT_CHAT_RATE_LIMIT_WINDOW_MS,
          },
        },
      }
    : {};

  // -----------------------------------------------------------------------
  // GET /api/sessions/:id
  // -----------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
    const user = getUser(req);
    const sessionId = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
      return reply.code(400).send({ error: "invalid_input", detail: "session id must be a UUID" });
    }
    const state = await loadSession(pool, user, sessionId);
    if (!state) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.code(200).send({
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
  });

  // -----------------------------------------------------------------------
  // GET /api/sessions — list the user's recent sessions.
  // Paged via ?limit (default 20, max 100). Returns id + summary fields only.
  // -----------------------------------------------------------------------
  app.get<{ Querystring: { limit?: string } }>("/api/sessions", async (req, reply) => {
    const user = getUser(req);
    const rawLimit = parseInt(req.query.limit ?? "20", 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 20;

    const rows = await withUserContext(pool, user, (client) =>
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

    return reply.code(200).send({
      sessions: rows.map((r) => ({
        session_id: r.id,
        last_finish_reason: r.last_finish_reason,
        awaiting_question: r.awaiting_question,
        message_count: r.message_count,
        created_at: r.created_at.toISOString(),
        updated_at: r.updated_at.toISOString(),
      })),
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/sessions/:id/plan/run — Phase E chained execution.
  // -----------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/plan/run",
    sessionMutatingRateLimit,
    (req, reply) => handlePlanRun(req, reply, deps),
  );

  // -----------------------------------------------------------------------
  // POST /api/sessions/:id/resume — Phase I auto-resume.
  // -----------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/resume",
    sessionMutatingRateLimit,
    (req, reply) => handleResume(req, reply, deps),
  );

  // -----------------------------------------------------------------------
  // POST /api/internal/sessions/:id/resume — JWT-authenticated auto-resume.
  // -----------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/api/internal/sessions/:id/resume",
    sessionMutatingRateLimit,
    (req, reply) => handleInternalResume(req, reply, deps),
  );
}

// `runChainedHarness` is re-exported from `../sessions.ts` so existing
// imports `import { runChainedHarness } from "../../src/routes/sessions.js"`
// (notably tests/integration/chained-execution.test.ts) keep resolving.
// The canonical home is now ../../core/chained-harness.ts.
