// Phase 2 of the configuration concept (Initiative 6).
//
// Single source of truth for feature flags. Reads feature_flags rows with a
// 60s cache; the env-var fallback survives so a deployment without the DB
// migration still behaves correctly. The DB row wins when both exist.

import type { Pool } from "pg";
import { withUserContext } from "../db/with-user-context.js";

export interface FlagContext {
  user?: string;
  project?: string;
  org?: string;
}

interface FlagRow {
  key: string;
  enabled: boolean;
  scope_rule: { orgs?: string[]; projects?: string[]; users?: string[] } | null;
  description: string;
  updated_at: string;
}

interface CacheEntry {
  fetchedAt: number;
  rows: Map<string, FlagRow>;
}

const _CACHE_TTL_MS = 60_000;

export class FeatureFlagRegistry {
  private cache: CacheEntry | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly ttlMs: number = _CACHE_TTL_MS,
  ) {}

  /**
   * True when the flag is enabled at the given context.
   *
   * Rules:
   *   1. DB row missing → fall through to env-var (uppercased + dotted-to-underscored
   *      key, e.g. "agent.confidence_cross_model" → "AGENT_CONFIDENCE_CROSS_MODEL").
   *   2. DB row present, enabled=false → flag is OFF (env var is ignored).
   *   3. DB row present, enabled=true, no scope_rule → flag is ON globally.
   *   4. DB row present, enabled=true, scope_rule set → AND of the rule tuples
   *      with the call context. Missing scope element on the call side → off
   *      for that rule.
   */
  async isEnabled(key: string, ctx: FlagContext = {}): Promise<boolean> {
    const row = await this.getRow(key);
    if (row === undefined) return envFallback(key);

    if (!row.enabled) return false;
    if (!row.scope_rule) return true;

    const r = row.scope_rule;
    if (r.users && r.users.length > 0 && (!ctx.user || !r.users.includes(ctx.user))) {
      return false;
    }
    if (r.projects && r.projects.length > 0 && (!ctx.project || !r.projects.includes(ctx.project))) {
      return false;
    }
    if (r.orgs && r.orgs.length > 0 && (!ctx.org || !r.orgs.includes(ctx.org))) {
      return false;
    }
    return true;
  }

  /** Returns every catalog row, used by GET /api/admin/feature-flags. */
  async listAll(): Promise<FlagRow[]> {
    await this.refreshIfStale();
    return [...(this.cache?.rows.values() ?? [])];
  }

  invalidate(): void {
    this.cache = null;
  }

  private async getRow(key: string): Promise<FlagRow | undefined> {
    await this.refreshIfStale();
    return this.cache?.rows.get(key);
  }

  private async refreshIfStale(): Promise<void> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < this.ttlMs) return;

    const rows = new Map<string, FlagRow>();
    try {
      const result = await withUserContext(this.pool, "__system__", async (client) => {
        return await client.query<FlagRow>(
          `SELECT key, enabled, scope_rule, description, updated_at::text
             FROM feature_flags`,
        );
      });
      for (const r of result.rows) rows.set(r.key, r);
    } catch {
      // DB unavailable; keep the prior cache if any so transient errors
      // don't yank flags out from under live requests.
      this.cache ??= { fetchedAt: now, rows: new Map() };
      return;
    }

    this.cache = { fetchedAt: now, rows };
  }
}

function envFallback(key: string): boolean {
  const envKey = key.toUpperCase().replace(/\./g, "_");
  const v = process.env[envKey];
  return v === "true" || v === "1";
}

let _instance: FeatureFlagRegistry | null = null;

export function setFeatureFlagRegistry(instance: FeatureFlagRegistry): void {
  _instance = instance;
}

export function getFeatureFlagRegistry(): FeatureFlagRegistry {
  if (!_instance) {
    throw new Error(
      "FeatureFlagRegistry not initialised — call setFeatureFlagRegistry from bootstrap.",
    );
  }
  return _instance;
}

/** Convenience helper used at call sites; reads the singleton. */
export async function isFeatureEnabled(key: string, ctx: FlagContext = {}): Promise<boolean> {
  return await getFeatureFlagRegistry().isEnabled(key, ctx);
}
