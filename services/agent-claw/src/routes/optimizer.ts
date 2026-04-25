// GET /api/optimizer/runs — Streamlit Optimizer page backend (Phase E).
//
// Returns GEPA run history from prompt_registry (gepa_metadata),
// skill promotion events, shadow comparisons, and golden-set score history.
//
// All responses are JSON; the Streamlit page renders them.

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

interface OptimizerRouteDeps {
  pool: Pool;
}

export function registerOptimizerRoutes(
  app: FastifyInstance,
  { pool }: OptimizerRouteDeps,
): void {
  // -----------------------------------------------------------------------
  // GET /api/optimizer/runs
  // Returns: list of GEPA candidate rows (inactive, with gepa_metadata).
  // -----------------------------------------------------------------------
  app.get("/api/optimizer/runs", async (_req, reply) => {
    const r = await pool.query<{
      name: string;
      version: number;
      active: boolean;
      shadow_until: Date | null;
      gepa_metadata: Record<string, unknown> | null;
      created_at: Date;
    }>(
      `SELECT name, version, active, shadow_until, gepa_metadata, created_at
         FROM prompt_registry
        WHERE gepa_metadata IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 100`,
    );
    return reply.code(200).send({ runs: r.rows });
  });

  // -----------------------------------------------------------------------
  // GET /api/optimizer/promotions
  // Returns: skill_promotion_events.
  // -----------------------------------------------------------------------
  app.get("/api/optimizer/promotions", async (_req, reply) => {
    const r = await pool.query(
      `SELECT skill_name, version, event_type, reason, metadata, created_at
         FROM skill_promotion_events
        ORDER BY created_at DESC
        LIMIT 200`,
    );
    return reply.code(200).send({ events: r.rows });
  });

  // -----------------------------------------------------------------------
  // GET /api/optimizer/shadow — shadow_run_scores aggregated by prompt.
  // -----------------------------------------------------------------------
  app.get("/api/optimizer/shadow", async (_req, reply) => {
    const r = await pool.query(
      `SELECT prompt_name, version,
              AVG(score) AS mean_score,
              COUNT(*) AS run_count,
              MIN(run_at) AS first_run_at,
              MAX(run_at) AS last_run_at
         FROM shadow_run_scores
        GROUP BY prompt_name, version
        ORDER BY last_run_at DESC`,
    );
    return reply.code(200).send({ shadows: r.rows });
  });

  // -----------------------------------------------------------------------
  // GET /api/optimizer/golden — last 30 shadow_run_scores for sparkline.
  // -----------------------------------------------------------------------
  app.get("/api/optimizer/golden", async (_req, reply) => {
    const r = await pool.query(
      `SELECT prompt_name, version, score, per_class_scores, run_at
         FROM shadow_run_scores
        ORDER BY run_at DESC
        LIMIT 30`,
    );
    return reply.code(200).send({ scores: r.rows });
  });
}
