// Phase 1 of the configuration concept.
//
// Single source of truth for /api/admin/* authorization. Replaces the env-var
// AGENT_ADMIN_USERS check that lived in routes/forged-tools.ts:isAdmin.
//
// Two layers, in order:
//   1. DB row in admin_roles (the new canonical path).
//   2. AGENT_ADMIN_USERS env list — kept as a bootstrap fallback so a fresh
//      deployment can grant the FIRST global admin without already having a
//      grant in the DB. Documented in the plan's "Out of scope" section.
//
// Resolution rule: a user is an admin if EITHER source grants the requested
// role at the requested scope (or globally).

import type { Pool } from "pg";
import { withUserContext } from "../db/with-user-context.js";
import { getLogger } from "../observability/logger.js";

export type AdminRole = "global_admin" | "org_admin" | "project_admin";

/**
 * Boot-time audit: walks AGENT_ADMIN_USERS entries and warns when one
 * differs only in case from an existing admin_roles row.
 *
 * Why this exists: the lookup at request time is case-insensitive
 * (line 54 below lower-cases both sides), but admin_roles INSERTs in
 * routes/admin/admin-users.ts lower-case the entra_id on write. Mixed
 * casing in env-var bootstrap (e.g. `AGENT_ADMIN_USERS=Alice@example.com`)
 * silently produces TWO records for the same person — one in env (case
 * preserved), one in DB (lower-cased). A revoke-by-original-case DELETE
 * misses the lower-cased DB row. This audit catches it at boot so an
 * operator sees the drift before it produces an orphaned grant.
 *
 * Idempotent — safe to call from any startup path. Failures are logged
 * but don't crash boot; the env-var grant works regardless.
 */
export async function auditAgentAdminUsersCasing(pool: Pool): Promise<void> {
  const raw = process.env.AGENT_ADMIN_USERS ?? "";
  if (!raw.trim()) return;
  const envEntries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (envEntries.length === 0) return;

  let dbRows: Array<{ user_entra_id: string }> = [];
  try {
    // Read admin_roles via withUserContext('__system__') — the table's
    // RLS policy admits authenticated callers; bootstrap admin reads
    // are intentionally allowed.
    dbRows = await withUserContext(pool, "__system__", async (client) => {
      const { rows } = await client.query<{ user_entra_id: string }>(
        "SELECT DISTINCT user_entra_id FROM admin_roles",
      );
      return rows;
    });
  } catch (err) {
    // Don't fail boot — the audit is informational. A schema-not-loaded
    // or RLS-broken state surfaces via other gates.
    getLogger("agent-claw.middleware.require-admin").warn(
      { event: "admin_users_casing_audit_failed", err },
      "Failed to read admin_roles for AGENT_ADMIN_USERS casing audit",
    );
    return;
  }

  const dbLower = new Set(dbRows.map((r) => r.user_entra_id.toLowerCase()));
  const log = getLogger("agent-claw.middleware.require-admin");
  for (const env of envEntries) {
    const lower = env.toLowerCase();
    if (env === lower) continue; // already lower-case — no risk
    if (dbLower.has(lower)) {
      log.warn(
        {
          event: "admin_users_case_drift",
          env_value: env,
          db_value_lower: lower,
        },
        "AGENT_ADMIN_USERS entry differs in case from an existing admin_roles row. " +
          "Revokes via DELETE keyed on the env-cased value would miss the lower-cased DB row. " +
          "Either lower-case the env entry or revoke the DB row before relying on env-only revoke.",
      );
    }
  }
}

/**
 * Returns true when the calling user has the named role at the named scope.
 *
 * Falls back to the AGENT_ADMIN_USERS env var only when role === 'global_admin'.
 * Lower-tier roles must be granted via the DB.
 */
export async function isAdmin(
  pool: Pool,
  userEntraId: string,
  role: AdminRole = "global_admin",
  scopeId = "",
): Promise<boolean> {
  if (!userEntraId) return false;

  // Layer 1 — DB. Uses the SECURITY DEFINER helper from
  // db/init/18_admin_roles_and_audit.sql so RLS doesn't recurse.
  const dbHit = await withUserContext(pool, userEntraId, async (client) => {
    const { rows } = await client.query<{ is_admin: boolean }>(
      "SELECT current_user_is_admin($1, $2) AS is_admin",
      [role, scopeId === "" ? null : scopeId],
    );
    return rows[0]?.is_admin === true;
  });
  if (dbHit) return true;

  // Layer 2 — env-var bootstrap. Only honoured for global_admin so it
  // can't accidentally widen scoped-admin checks.
  if (role !== "global_admin") return false;
  const raw = process.env.AGENT_ADMIN_USERS ?? "";
  if (!raw.trim()) return false;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(userEntraId.toLowerCase());
}

/**
 * Throws an authorization error when the caller is not an admin.
 *
 * Designed to be called inside route handlers. Returns the value `true` so
 * the caller can `await requireAdmin(...)` without an awkward assignment.
 */
export async function requireAdmin(
  pool: Pool,
  userEntraId: string,
  role: AdminRole = "global_admin",
  scopeId = "",
): Promise<true> {
  const ok = await isAdmin(pool, userEntraId, role, scopeId);
  if (!ok) {
    const err = new AdminPermissionError(
      `User '${userEntraId || "(anonymous)"}' lacks ${role}` +
        (scopeId ? ` on scope '${scopeId}'` : "") +
        ".",
    );
    throw err;
  }
  return true;
}

export class AdminPermissionError extends Error {
  readonly statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = "AdminPermissionError";
  }
}

/**
 * Convenience guard for Fastify routes. Checks admin status; on failure
 * sends 403 and returns false so the handler can `if (!ok) return;`.
 */
export async function guardAdmin(
  pool: Pool,
  userEntraId: string,
  reply: { status(code: number): { send(payload: unknown): unknown } },
  role: AdminRole = "global_admin",
  scopeId = "",
): Promise<boolean> {
  if (await isAdmin(pool, userEntraId, role, scopeId)) return true;
  reply.status(403).send({
    error: `Permission denied. Requires ${role}` +
      (scopeId ? ` on scope '${scopeId}'` : "") +
      ".",
  });
  return false;
}
