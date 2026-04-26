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
// Projectors and system workers pass '' (empty string) as userEntraId.
// RLS policies are written to treat empty-string context permissively.

import { type Pool, type PoolClient } from "pg";

export async function withUserContext<T>(
  pool: Pool,
  userEntraId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.current_user_entra_id', $1, true)",
      [userEntraId],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rbErr) {
      // Surface the rollback failure so an errant client isn't returned
      // to the pool in an unknown state.
      (err as { rollbackError?: unknown }).rollbackError = rbErr;
    }
    throw err;
  } finally {
    client.release();
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
  return withUserContext(pool, SYSTEM_USER_ENTRA_ID, fn);
}
