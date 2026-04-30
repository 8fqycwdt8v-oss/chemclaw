// Phase 3 of the configuration concept (Initiative 5).
//
// In-process cache for permission_policies rows. Loaded with a 60s TTL the
// same way prompt_registry, config_settings, and feature_flags are. The
// permission hook calls match() on every pre_tool dispatch; that path must
// stay sync once the cache is warm, so refresh is a separate async helper
// the hook calls before evaluating.

import type { Pool } from "pg";
import { withSystemContext } from "../../db/with-user-context.js";

export type PolicyDecision = "allow" | "deny" | "ask";

export interface PolicyRow {
  id: string;
  scope: "global" | "org" | "project";
  scopeId: string;
  decision: PolicyDecision;
  toolPattern: string;
  argumentPattern: string | null;
  reason: string | null;
  enabled: boolean;
}

const _CACHE_TTL_MS = 60_000;

function patternMatches(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (pattern.endsWith("*") && value.startsWith(pattern.slice(0, -1))) return true;
  return false;
}

export interface PolicyMatchContext {
  toolId: string;
  inputJson: string; // JSON.stringify of tool input
  org?: string;
  project?: string;
}

export class PermissionPolicyLoader {
  private cache: PolicyRow[] | null = null;
  private cacheAt = 0;

  constructor(
    private readonly pool: Pool,
    private readonly ttlMs: number = _CACHE_TTL_MS,
  ) {}

  async refreshIfStale(): Promise<void> {
    const now = Date.now();
    if (this.cache !== null && now - this.cacheAt < this.ttlMs) return;
    try {
      const rows = await withSystemContext(this.pool, async (client) => {
        const r = await client.query<{
          id: string;
          scope: "global" | "org" | "project";
          scope_id: string;
          decision: PolicyDecision;
          tool_pattern: string;
          argument_pattern: string | null;
          reason: string | null;
          enabled: boolean;
        }>(
          `SELECT id::text, scope, scope_id, decision, tool_pattern,
                  argument_pattern, reason, enabled
             FROM permission_policies
            WHERE enabled = TRUE`,
        );
        return r.rows;
      });
      this.cache = rows.map((r) => ({
        id: r.id,
        scope: r.scope,
        scopeId: r.scope_id,
        decision: r.decision,
        toolPattern: r.tool_pattern,
        argumentPattern: r.argument_pattern,
        reason: r.reason,
        enabled: r.enabled,
      }));
      this.cacheAt = now;
    } catch {
      // DB unavailable — keep prior cache to avoid mid-flight policy flips.
      if (this.cache === null) {
        this.cache = [];
        this.cacheAt = now;
      }
    }
  }

  invalidate(): void {
    this.cache = null;
  }

  /**
   * Returns the strongest applicable decision under the deny>ask>allow
   * aggregator, or null when no policy matches. Caller decides what to do
   * with null (the lifecycle treats it as "no opinion" → resolver falls
   * through to its default).
   */
  match(ctx: PolicyMatchContext): { decision: PolicyDecision; reason: string } | null {
    if (this.cache === null) return null;

    const candidates = this.cache.filter((p) => {
      if (!patternMatches(p.toolPattern, ctx.toolId)) return false;
      if (p.argumentPattern) {
        try {
          if (!new RegExp(p.argumentPattern).test(ctx.inputJson)) return false;
        } catch {
          // Bad regex — skip the row rather than rejecting the call.
          return false;
        }
      }
      if (p.scope === "org"     && p.scopeId !== ctx.org)     return false;
      if (p.scope === "project" && p.scopeId !== ctx.project) return false;
      return true;
    });

    // deny > ask > allow
    const order: Record<PolicyDecision, number> = { deny: 3, ask: 2, allow: 1 };
    candidates.sort((a, b) => order[b.decision] - order[a.decision]);
    const winner = candidates[0];
    if (!winner) return null;
    return {
      decision: winner.decision,
      reason: winner.reason ?? `policy(${winner.scope}:${winner.scopeId}:${winner.toolPattern})`,
    };
  }
}

let _instance: PermissionPolicyLoader | null = null;

export function setPermissionPolicyLoader(loader: PermissionPolicyLoader): void {
  _instance = loader;
}

export function getPermissionPolicyLoader(): PermissionPolicyLoader | null {
  return _instance;
}
