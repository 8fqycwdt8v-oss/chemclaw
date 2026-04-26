// GET /api/sessions/:id — session status endpoint.
// GET /api/sessions    — list the calling user's recent sessions.
//
// Used by client UIs to render progress (todos), resume affordances
// (awaiting_question), and a session picker.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { loadSession } from "../core/session-store.js";
import { withUserContext } from "../db/with-user-context.js";

interface SessionsRouteDeps {
  pool: Pool;
  getUser: (req: FastifyRequest) => string;
}

export function registerSessionsRoute(
  app: FastifyInstance,
  { pool, getUser }: SessionsRouteDeps,
): void {
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
}
