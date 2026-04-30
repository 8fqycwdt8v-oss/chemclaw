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

export type AdminRole = "global_admin" | "org_admin" | "project_admin";

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
