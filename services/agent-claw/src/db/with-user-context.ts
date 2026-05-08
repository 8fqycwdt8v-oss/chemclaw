// Row-Level Security helper — ported from services/agent/src/db.ts.
//
// Every user-facing query MUST run inside a call to withUserContext.
// The `set_config(..., true)` call makes the setting transaction-local, so
// no context leaks out of this transaction even when the pool client is reused.
//
// Pattern:
//   withUserContext(pool, req.user.entraId, async (client) => {
//     return client.query("SELECT * FROM documents");
//   });
//
// System workers connect as chemclaw_service (BYPASSRLS, see
// db/init/12_security_hardening.sql) and never set
// app.current_user_entra_id. App-side code paths that need to read
// globally-scoped catalogs (prompt_registry, skill_library, mcp_tools)
// from the chemclaw_app role must use withSystemContext, which sets the
// '__system__' sentinel — empty-string is no longer a permissive value
// under FORCE ROW LEVEL SECURITY.

import { type Pool, type PoolClient } from "pg";

import { hashUser } from "../observability/user-hash.js";
import { getLogger } from "../observability/logger.js";

// Slow-transaction threshold. Any withUserContext block whose total
// duration exceeds this emits a structured warn record (event=db_slow_txn)
// so operators can spot pathological queries in Loki without enabling
// log_min_duration_statement on every Postgres replica. Default chosen
// conservatively at 200ms — typical project-scoped reads finish in <50ms;
// a 200ms ceiling catches missing indexes and N+1 patterns.
const SLOW_TXN_MS = Number(process.env.DB_SLOW_TXN_MS ?? "200");

export async function withUserContext<T>(
  pool: Pool,
  userEntraId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const log = getLogger("agent-claw.db");
  const userHash = hashUser(userEntraId);
  const started = Date.now();
  const client = await pool.connect();
  // Track whether we hit any failure path; if so, destroy the client on
  // release rather than returning it to the pool with a possibly-open or
  // half-aborted transaction. node-postgres `client.release(err)` (truthy
  // arg) discards the client; `release()` returns it to the pool. Without
  // this guard, an exception thrown after `pool.connect()` resolved but
  // before `BEGIN` succeeded — or any error during ROLLBACK — could put
  // the client back in the pool with leftover transaction state and the
  // next caller sees stray rows / serialization errors.
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.current_user_entra_id', $1, true)",
      [userEntraId],
    );
    log.debug(
      { event: "rls_context_set", user: userHash },
      "RLS context set on transaction",
    );
    const result = await fn(client);
    await client.query("COMMIT");
    const duration = Date.now() - started;
    if (duration >= SLOW_TXN_MS) {
      log.warn(
        {
          event: "db_slow_txn",
          error_code: "DB_SLOW_QUERY",
          duration_ms: duration,
          user: userHash,
        },
        "RLS-scoped DB transaction exceeded slow threshold",
      );
    }
    return result;
  } catch (err) {
    const duration = Date.now() - started;
    releaseError = err as Error;
    try {
      await client.query("ROLLBACK");
    } catch (rbErr) {
      // Surface the rollback failure so an errant client isn't returned
      // to the pool in an unknown state. `releaseError` already captures
      // the original throw, which guarantees the finally below destroys
      // the client; we attach the rollback failure for diagnostics.
      (err as { rollbackError?: unknown }).rollbackError = rbErr;
    }
    log.error(
      {
        event: "db_txn_failed",
        duration_ms: duration,
        user: userHash,
        err_name: (err as Error).name,
        err_msg: (err as Error).message,
      },
      "RLS-scoped DB transaction failed; rolled back",
    );
    throw err;
  } finally {
    // node-postgres: passing a truthy arg to release() destroys the client
    // instead of returning it to the pool. Use this whenever an error has
    // been observed so a client whose transaction state we can't trust
    // doesn't pollute subsequent connections.
    client.release(releaseError);
  }
}

/**
 * Sentinel user-entra-id used by `withSystemContext` for queries that read
 * globally-cached / system-scoped data (e.g. mcp_tools catalog, prompt_registry
 * version lookups). Different from the empty string ('') so legacy
 * "permissive-on-empty" RLS policies don't accidentally widen the gate.
 *
 * Queried as a string literal in the new policies in
 * db/init/12_security_hardening.sql (`IS NOT NULL AND <> ''`), so any
 * non-empty value passes those gates.
 */
export const SYSTEM_USER_ENTRA_ID = "__system__";

/**
 * Same contract as `withUserContext`, but uses a fixed system sentinel for
 * `app.current_user_entra_id`. Use for code paths that legitimately need to
 * read globally-shared state without any specific user context — for example
 * reading the prompt_registry catalog or the mcp_tools row that names a
 * forged tool.
 *
 * Do NOT use this to bypass RLS on per-user / per-project tables. For those,
 * call `withUserContext` with the real Entra-ID.
 */
export async function withSystemContext<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return await withUserContext(pool, SYSTEM_USER_ENTRA_ID, fn);
}
