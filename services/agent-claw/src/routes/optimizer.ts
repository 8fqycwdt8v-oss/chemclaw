// GET /api/optimizer/* — Optimizer status backend (Phase E). Surfaced to
// any SSE-consuming client; the legacy in-tree page (Phase E doc) was removed.
//
// Returns GEPA run history from prompt_registry (gepa_metadata),
// skill promotion events, shadow comparisons, and golden-set score history.
//
// AUTH: every route requires the caller to be a global_admin per the canonical
// admin_roles table (see middleware/require-admin.ts). Optimizer data
// includes prompt versions and shadow scores derived from real chats — must
// not be exposed to non-admin callers.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { withSystemContext } from "../db/with-user-context.js";
import { isAdmin } from "../middleware/require-admin.js";

interface OptimizerRouteDeps {
  pool: Pool;
  /** Resolves the calling user's Entra-ID. Throws (→ 401) if missing. */
  getUser: (req: FastifyRequest) => string;
}

async function gateAdmin(
  pool: Pool,
  getUser: (req: FastifyRequest) => string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null> {
  const user = getUser(req);
  if (!(await isAdmin(pool, user))) {
    reply.code(403).send({
      error: "forbidden",
      detail: "optimizer routes require global_admin",
    });
    return null;
  }
  return user;
}

export function registerOptimizerRoutes(
  app: FastifyInstance,
  { pool, getUser }: OptimizerRouteDeps,
): void {
  // Optimizer routes read system-scoped catalog tables (prompt_registry,
  // skill_promotion_events, shadow_run_scores). Under FORCE RLS + the
  // chemclaw_app role, raw pool.query returns zero rows because no
  // policy matches an empty user. We wrap each query in withSystemContext
  // (sentinel '__system__' user) so the policies that gate on
  // current_setting('app.current_user_entra_id') being non-empty pass.
  // The admin gate has already authorized the calling user.

  // -----------------------------------------------------------------------
  // GET /api/optimizer/runs
  // -----------------------------------------------------------------------
  app.get("/api/optimizer/runs", async (req, reply) => {
    if (!(await gateAdmin(pool, getUser, req, reply))) return;
    const r = await withSystemContext(pool, (client) =>
      client.query<{
        prompt_name: string;
        version: number;
        active: boolean;
        shadow_until: Date | null;
        gepa_metadata: Record<string, unknown> | null;
        created_at: Date;
      }>(
        `SELECT prompt_name, version, active, shadow_until, gepa_metadata, created_at
           FROM prompt_registry
          WHERE gepa_metadata IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 100`,
      ),
    );
    return await reply.code(200).send({ runs: r.rows });
  });

  // -----------------------------------------------------------------------
  // GET /api/optimizer/promotions
  // -----------------------------------------------------------------------
  app.get("/api/optimizer/promotions", async (req, reply) => {
    if (!(await gateAdmin(pool, getUser, req, reply))) return;
    const r = await withSystemContext(pool, (client) =>
      client.query(
        `SELECT skill_name, version, event_type, reason, metadata, created_at
           FROM skill_promotion_events
          ORDER BY created_at DESC
          LIMIT 200`,
      ),
    );
    return await reply.code(200).send({ events: r.rows });
  });

  // -----------------------------------------------------------------------
  // GET /api/optimizer/shadow — shadow_run_scores aggregated by prompt.
  // -----------------------------------------------------------------------
  app.get("/api/optimizer/shadow", async (req, reply) => {
    if (!(await gateAdmin(pool, getUser, req, reply))) return;
    const r = await withSystemContext(pool, (client) =>
      client.query(
        `SELECT prompt_name, version,
                AVG(score) AS mean_score,
                COUNT(*) AS run_count,
                MIN(run_at) AS first_run_at,
                MAX(run_at) AS last_run_at
           FROM shadow_run_scores
          GROUP BY prompt_name, version
          ORDER BY last_run_at DESC`,
      ),
    );
    return await reply.code(200).send({ shadows: r.rows });
  });

  // -----------------------------------------------------------------------
  // GET /api/optimizer/golden — last 30 shadow_run_scores for sparkline.
  // -----------------------------------------------------------------------
  app.get("/api/optimizer/golden", async (req, reply) => {
    if (!(await gateAdmin(pool, getUser, req, reply))) return;
    const r = await withSystemContext(pool, (client) =>
      client.query(
        `SELECT prompt_name, version, score, per_class_scores, run_at
           FROM shadow_run_scores
          ORDER BY run_at DESC
          LIMIT 30`,
      ),
    );
    return await reply.code(200).send({ scores: r.rows });
  });
}
