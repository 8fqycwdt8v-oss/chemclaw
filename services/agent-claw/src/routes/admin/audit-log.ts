// Phase 1 of the configuration concept (Initiative 10).
//
// Single helper used by every /api/admin/* mutation handler to record an
// append-only row in admin_audit_log. The actor stamp is enforced by RLS
// (see db/init/18_admin_roles_and_audit.sql admin_audit_log_insert policy)
// so a handler can't forge a row claiming to be someone else.

import type { Pool } from "pg";
import { trace } from "@opentelemetry/api";
import { withUserContext } from "../../db/with-user-context.js";
import { getRequestContext } from "../../core/request-context.js";

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
  /**
   * Override the request_id stamped on the row. Normally NOT supplied —
   * appendAudit reads from the AsyncLocalStorage RequestContext that
   * the route handler set at turn start.
   */
  requestId?: string;
  /**
   * Override the trace_id stamped on the row. Normally NOT supplied —
   * appendAudit reads from the OTel active span.
   */
  traceId?: string;
}

/**
 * Insert a single audit-log row inside its own RLS-scoped transaction.
 *
 * Returns the row id. Throws when the actor's RLS check fails — which only
 * happens when actor !== current user, i.e. handler bug.
 *
 * The request_id and trace_id are auto-populated from the active
 * AsyncLocalStorage RequestContext + active OTel span so admin entries
 * can be pivoted to Loki + Langfuse without callers having to thread
 * the IDs through every helper. Pre-fix the audit_log schema only had
 * {occurred_at, actor, action, target, before_value, after_value,
 * reason} so an alert on "config.set on PROD secret bucket" couldn't
 * be linked to its originating HTTP request.
 */
export async function appendAudit(pool: Pool, entry: AuditEntry): Promise<string> {
  const { actor, action, target, beforeValue, afterValue, reason } = entry;
  const requestId = entry.requestId ?? getRequestContext()?.requestId ?? null;
  const activeSpan = trace.getActiveSpan();
  const spanCtx = activeSpan?.spanContext();
  const traceId =
    entry.traceId ??
    (spanCtx && spanCtx.traceId !== "00000000000000000000000000000000"
      ? spanCtx.traceId
      : null);

  const row = await withUserContext(pool, actor, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO admin_audit_log
         (actor, action, target, before_value, after_value, reason,
          request_id, trace_id)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
       RETURNING id::text`,
      [
        actor,
        action,
        target,
        beforeValue === undefined ? null : JSON.stringify(beforeValue),
        afterValue === undefined ? null : JSON.stringify(afterValue),
        reason ?? null,
        requestId,
        traceId,
      ],
    );
    return rows[0] ?? null;
  });
  if (!row) {
    throw new Error("admin_audit_log INSERT returned no row — RLS denied or no policy match.");
  }
  return row.id;
}
