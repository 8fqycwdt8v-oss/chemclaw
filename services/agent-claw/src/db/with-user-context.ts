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
