// Prompt registry access layer.
//
// Ported from services/agent/src/agent/prompts.ts.
//
// The system prompt lives in Postgres (`prompt_registry`) so it can be
// versioned, A/B tested, and evolved by the self-improvement (DSPy GEPA)
// pipeline without redeploying the agent. The agent service fetches the
// active version at each turn and caches it briefly to avoid hammering
// Postgres on every chat request.
//
// Phase E additions:
//   - getShadowPrompts(name): loads prompts with shadow_until > NOW()
//   - recordShadowScore(name, version, traceId, score, perClassScores): writes shadow_run_scores
//   - getShadowSummary(name, version): reads aggregated shadow score data

import type { Pool } from "pg";
import { withSystemContext } from "../db/with-user-context.js";

interface CacheEntry {
  fetchedAt: number;
  template: string;
  version: number;
}

export interface ShadowPrompt {
  template: string;
  version: number;
  shadowUntil: Date;
}

export interface ShadowSummary {
  promptName: string;
  version: number;
  meanScore: number;
  runCount: number;
  perClassScores: Record<string, number> | null;
  latestRunAt: Date | null;
}

const _CACHE_TTL_MS = 60_000;

export class PromptRegistry {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly pool: Pool) {}

  /**
   * Returns the template text for the active version of `name`.
   * Throws if no active version is registered — we never fall back to
   * a hardcoded prompt at runtime, because that would bypass governance.
   */
  async getActive(name: string): Promise<{ template: string; version: number }> {
    const now = Date.now();
    const cached = this.cache.get(name);
    if (cached && now - cached.fetchedAt < _CACHE_TTL_MS) {
      return { template: cached.template, version: cached.version };
    }

    // prompt_registry is a globally-shared catalog (FORCE RLS requires a
    // non-empty user context). System sentinel passes the authenticated-user
    // gate without coupling to any specific tenant.
    const r = await withSystemContext(this.pool, (client) =>
      client.query<{ template: string; version: number }>(
        `SELECT template, version
           FROM prompt_registry
          WHERE name = $1 AND active = TRUE
          LIMIT 1`,
        [name],
      ),
    );
    if (r.rows.length === 0 || !r.rows[0]) {
      throw new Error(`no active prompt registered for "${name}"`);
    }
    const { template, version } = r.rows[0];
    this.cache.set(name, { fetchedAt: now, template, version });
    return { template, version };
  }

  /**
   * Phase E — returns all shadow prompts for `name` (shadow_until > NOW()).
   * These are GEPA candidates running in parallel shadow evaluation.
   * Returns empty array if no shadow prompts exist.
   */
  async getShadowPrompts(name: string): Promise<ShadowPrompt[]> {
    const r = await withSystemContext(this.pool, (client) =>
      client.query<{
        template: string;
        version: number;
        shadow_until: Date;
      }>(
        `SELECT template, version, shadow_until
           FROM prompt_registry
          WHERE name = $1
            AND active = FALSE
            AND shadow_until > NOW()
          ORDER BY version DESC`,
        [name],
      ),
    );
    return r.rows.map((row) => ({
      template: row.template,
      version: row.version,
      shadowUntil: row.shadow_until,
    }));
  }

  /**
   * Phase E — write a shadow evaluation score to shadow_run_scores.
   * Called after evaluating a shadow prompt in parallel (non-user-visible).
   */
  async recordShadowScore(
    promptName: string,
    version: number,
    traceId: string | null,
    score: number,
    perClassScores: Record<string, number> | null = null,
  ): Promise<void> {
    // shadow_run_scores has no per-user scoping; system context is correct here.
    await withSystemContext(this.pool, (client) =>
      client.query(
        `INSERT INTO shadow_run_scores
           (prompt_name, version, trace_id, score, per_class_scores)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          promptName,
          version,
          traceId,
          score,
          perClassScores ? JSON.stringify(perClassScores) : null,
        ],
      ),
    );
  }

  /**
   * Phase E — aggregate shadow_run_scores for a given (prompt_name, version).
   * Returns null if no scores exist yet.
   */
  async getShadowSummary(
    promptName: string,
    version: number,
  ): Promise<ShadowSummary | null> {
    const r = await withSystemContext(this.pool, (client) =>
      client.query<{
        mean_score: number;
        run_count: string;
        latest_run_at: Date | null;
      }>(
        `SELECT AVG(score) AS mean_score,
                COUNT(*) AS run_count,
                MAX(run_at) AS latest_run_at
           FROM shadow_run_scores
          WHERE prompt_name = $1 AND version = $2`,
        [promptName, version],
      ),
    );

    if (!r.rows[0] || r.rows[0].run_count === "0") return null;

    // Per-class breakdown — average per class from the per_class_scores JSONB.
    const classR = await withSystemContext(this.pool, (client) =>
      client.query<{ class_name: string; avg_score: number }>(
        `SELECT key AS class_name, AVG(value::float8) AS avg_score
           FROM shadow_run_scores,
                jsonb_each_text(per_class_scores) AS kv(key, value)
          WHERE prompt_name = $1 AND version = $2
            AND per_class_scores IS NOT NULL
          GROUP BY key`,
        [promptName, version],
      ),
    );
    const perClass: Record<string, number> = {};
    for (const row of classR.rows) {
      perClass[row.class_name] = row.avg_score;
    }

    return {
      promptName,
      version,
      meanScore: r.rows[0].mean_score,
      runCount: parseInt(r.rows[0].run_count, 10),
      perClassScores: classR.rows.length > 0 ? perClass : null,
      latestRunAt: r.rows[0].latest_run_at,
    };
  }

  /**
   * Phase E — check whether a shadow prompt meets auto-promotion criteria:
   *   shadowMeanScore >= activeMeanScore + 0.05
   *   AND shadowMeanScore >= 0.80 (absolute floor)
   *   AND no per-class score drops more than 0.02 vs active
   *
   * Returns true if the shadow should be promoted.
   */
  async shouldAutoPromote(
    promptName: string,
    shadowVersion: number,
    activeMeanScore: number,
    activePerClassScores: Record<string, number> | null,
  ): Promise<boolean> {
    const summary = await this.getShadowSummary(promptName, shadowVersion);
    if (!summary) return false;

    if (summary.meanScore < 0.80) return false;
    if (summary.meanScore < activeMeanScore + 0.05) return false;

    // Per-class drop check.
    if (activePerClassScores && summary.perClassScores) {
      for (const [cls, activeScore] of Object.entries(activePerClassScores)) {
        const shadowClassScore = summary.perClassScores[cls] ?? activeScore;
        if (activeScore - shadowClassScore > 0.02) return false;
      }
    }

    return true;
  }

  /**
   * Returns the cache entry age in ms, or null if not cached.
   * Used by tests to verify TTL behavior.
   */
  cacheAgeMs(name: string): number | null {
    const entry = this.cache.get(name);
    if (!entry) return null;
    return Date.now() - entry.fetchedAt;
  }

  /** Clear the cache — useful for tests and for hot-reload after prompt edits. */
  invalidate(): void {
    this.cache.clear();
  }
}
