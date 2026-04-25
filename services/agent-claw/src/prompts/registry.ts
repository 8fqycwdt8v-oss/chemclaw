// Prompt registry access layer.
//
// Ported from services/agent/src/agent/prompts.ts.
//
// The system prompt lives in Postgres (`prompt_registry`) so it can be
// versioned, A/B tested, and evolved by the self-improvement (DSPy GEPA)
// pipeline without redeploying the agent. The agent service fetches the
// active version at each turn and caches it briefly to avoid hammering
// Postgres on every chat request.

import type { Pool } from "pg";

interface CacheEntry {
  fetchedAt: number;
  template: string;
  version: number;
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

    const r = await this.pool.query<{ template: string; version: number }>(
      `SELECT template, version
         FROM prompt_registry
        WHERE name = $1 AND active = TRUE
        LIMIT 1`,
      [name],
    );
    if (r.rows.length === 0 || !r.rows[0]) {
      throw new Error(`no active prompt registered for "${name}"`);
    }
    const { template, version } = r.rows[0];
    this.cache.set(name, { fetchedAt: now, template, version });
    return { template, version };
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
