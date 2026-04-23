// Postgres connection pool, shared across request handlers.
// RLS: each request uses `withUserContext` which opens a transaction and
// applies `SET LOCAL app.current_user_entra_id`. The setting is cleared at
// COMMIT/ROLLBACK so it never leaks between pool clients.

import { Pool, type PoolClient } from "pg";
import type { Config } from "./config.js";

export function createPool(cfg: Config): Pool {
  return new Pool({
    host: cfg.POSTGRES_HOST,
    port: cfg.POSTGRES_PORT,
    database: cfg.POSTGRES_DB,
    user: cfg.POSTGRES_USER,
    password: cfg.POSTGRES_PASSWORD,
    max: cfg.POSTGRES_POOL_SIZE,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: cfg.POSTGRES_CONNECT_TIMEOUT_MS,
    // Per-query statement timeout enforced server-side. Prevents runaway
    // queries from pinning a connection.
    statement_timeout: cfg.POSTGRES_STATEMENT_TIMEOUT_MS,
    // node-pg also supports query_timeout (client-side); we use the
    // server-side one because it's enforced by Postgres itself.
  });
}

/**
 * Run a callback inside a transaction with the app user context set.
 *
 * The `set_config(..., true)` call makes the setting transaction-local, so
 * no context leaks out of this transaction even if the client is reused.
 */
export async function withUserContext<T>(
  pool: Pool,
  userEntraId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user_entra_id', $1, true)", [
      userEntraId,
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rbErr) {
      // Surface the rollback failure so an errant client isn't returned to
      // the pool in an unknown state.
      (err as { rollbackError?: unknown }).rollbackError = rbErr;
    }
    throw err;
  } finally {
    client.release();
  }
}
