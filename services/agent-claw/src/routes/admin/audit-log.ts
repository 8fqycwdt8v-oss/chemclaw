// Phase 1 of the configuration concept (Initiative 10).
//
// Single helper used by every /api/admin/* mutation handler to record an
// append-only row in admin_audit_log. The actor stamp is enforced by RLS
// (see db/init/18_admin_roles_and_audit.sql admin_audit_log_insert policy)
// so a handler can't forge a row claiming to be someone else.

import type { Pool } from "pg";
import { withUserContext } from "../../db/with-user-context.js";

export interface AuditEntry {
  /** entra_id of the caller. RLS check enforces actor === current_user. */
  actor: string;
  /** dotted resource type + verb, e.g. "admin_role.grant", "config.set". */
  action: string;
  /** identifier of the touched resource (user entra_id, key name, …). */
  target: string;
  /** prior state; NULL for creates. */
  beforeValue?: unknown;
  /** new state; NULL for deletes. */
  afterValue?: unknown;
  /** optional free-text justification surfaced in the audit UI. */
  reason?: string;
}

/**
 * Insert a single audit-log row inside its own RLS-scoped transaction.
 *
 * Returns the row id. Throws when the actor's RLS check fails — which only
 * happens when actor !== current user, i.e. handler bug.
 */
export async function appendAudit(pool: Pool, entry: AuditEntry): Promise<string> {
  const { actor, action, target, beforeValue, afterValue, reason } = entry;
  const row = await withUserContext(pool, actor, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO admin_audit_log
         (actor, action, target, before_value, after_value, reason)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
       RETURNING id::text`,
      [
        actor,
        action,
        target,
        beforeValue === undefined ? null : JSON.stringify(beforeValue),
        afterValue === undefined ? null : JSON.stringify(afterValue),
        reason ?? null,
      ],
    );
    return rows[0] ?? null;
  });
  if (!row) {
    throw new Error("admin_audit_log INSERT returned no row — RLS denied or no policy match.");
  }
  return row.id;
}
