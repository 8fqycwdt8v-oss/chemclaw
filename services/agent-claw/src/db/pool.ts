// Postgres connection pool — shared across all request handlers.
//
// RLS: every user-facing query must run via withUserContext.
// System queries (catalog reads) use withSystemContext (sentinel user '__system__').
//
// The agent connects as chemclaw_app (LOGIN, NO BYPASSRLS) so every row read
// is gated by the policy `current_setting('app.current_user_entra_id') = X`.
// Backward compatibility: if CHEMCLAW_APP_USER / CHEMCLAW_APP_PASSWORD aren't
// set, fall back to POSTGRES_USER / POSTGRES_PASSWORD so the migration can
// roll out one service at a time.

import { Pool } from "pg";
import type { Config } from "../config.js";

export function createPool(cfg: Config): Pool {
  // Prefer the dedicated app role; fall back to the legacy single-role config.
  const user = cfg.CHEMCLAW_APP_USER || cfg.POSTGRES_USER;
  const password = cfg.CHEMCLAW_APP_PASSWORD || cfg.POSTGRES_PASSWORD;
  return new Pool({
    host: cfg.POSTGRES_HOST,
    port: cfg.POSTGRES_PORT,
    database: cfg.POSTGRES_DB,
    user,
    password,
    max: cfg.POSTGRES_POOL_SIZE,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: cfg.POSTGRES_CONNECT_TIMEOUT_MS,
    // Server-side statement timeout prevents runaway queries from holding connections.
    // node-pg passes this as a connection parameter, not a SET command.
    statement_timeout: cfg.POSTGRES_STATEMENT_TIMEOUT_MS,
  });
}
