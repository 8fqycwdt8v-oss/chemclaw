// Postgres connection pool — shared across all request handlers.
// RLS: every user-facing query must run via withUserContext (see below).
// System queries (projectors, tool-registry loads) use '' as userEntraId,
// which RLS policies treat as "system / bypass".

import { Pool } from "pg";
import type { Config } from "../config.js";

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
    // Server-side statement timeout prevents runaway queries from holding connections.
    // node-pg passes this as a connection parameter, not a SET command.
    statement_timeout: cfg.POSTGRES_STATEMENT_TIMEOUT_MS,
  });
}
