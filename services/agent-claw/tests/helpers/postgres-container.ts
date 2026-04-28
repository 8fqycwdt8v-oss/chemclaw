// Shared Postgres testcontainer for integration tests.
//
// Phase 8 of the harness control-plane rebuild plan. Spins up a single
// Postgres container per test run, applies a minimal subset of db/init/*.sql
// to it, and hands back a `pg.Pool` connected to it. Reused across describe
// blocks via a module-level singleton — vitest's globalSetup is overkill for
// the small number of integration tests we have.
//
// Image choice: `timescale/timescaledb-ha:pg16-ts2.17-all`. Production runs
// the same image; it ships uuid-ossp + pgvector + pgvectorscale. The alpine
// postgres image would force us to ship a custom one to get vector — not
// worth it.
//
// Schema scope: we only need agent_sessions, agent_todos, and agent_plans
// for the Phase-8 integration tests. Running ALL of db/init/*.sql trips
// over recent pgvector versions rejecting >2000-dim ivfflat indexes in
// 01_schema, which aborts the whole transaction and leaves uuid_generate_v4
// undefined for every later file. Instead, we manually create the
// uuid-ossp extension + set_updated_at function + chemclaw_app/service
// roles, then apply 13_agent_sessions.sql and 14_agent_session_extensions.sql
// from disk. If a future test needs a different table, add another file
// to the per-test allowlist below.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let _container: StartedPostgreSqlContainer | null = null;
let _pool: Pool | null = null;
let _startupError: Error | null = null;

/**
 * Start (or reuse) a Postgres container and return a connected Pool.
 *
 * The container is shared across all tests in a single `vitest` run for
 * speed. Tests that need true isolation should namespace their inserts
 * via unique user_entra_ids — RLS keeps the rows from cross-contaminating.
 *
 * @param repoRoot Absolute path to the repository root (where `db/init/`
 *                 lives).
 */
export async function startTestPostgres(
  repoRoot: string,
): Promise<{ pool: Pool; container: StartedPostgreSqlContainer }> {
  if (_startupError) {
    throw _startupError;
  }
  if (_container && _pool) return { pool: _pool, container: _container };

  try {
    // Use the same image production uses so vector + vectorscale extensions
    // are present. The agent_sessions DDL doesn't need them, but db/init/01
    // creates them up front and would otherwise abort the whole script.
    _container = await new PostgreSqlContainer("timescale/timescaledb-ha:pg16-ts2.17-all")
      .withDatabase("chemclaw_test")
      .withUsername("chemclaw")
      .withPassword("test")
      .withStartupTimeout(120_000)
      .start();

    _pool = new Pool({
      connectionString: _container.getConnectionUri(),
      // Cap the pool so a buggy test doesn't fanout 100 simultaneous
      // connections against the container.
      max: 8,
    });

    // ---- Bootstrap: minimum prerequisites for agent_sessions DDL. ----
    // uuid-ossp gives uuid_generate_v4(); set_updated_at() is the trigger
    // function 13_agent_sessions.sql attaches to the timestamp triggers.
    // We also create the chemclaw_app + chemclaw_service roles so the
    // grants in 13_agent_sessions.sql succeed.
    await _pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await _pool.query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $func$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $func$ LANGUAGE plpgsql;
    `);
    // The roles 13_agent_sessions.sql grants to. We make them NOSUPERUSER
    // NOLOGIN — tests connect as the container's superuser so they sidestep
    // RLS via withUserContext + set_config, which is the contract the real
    // agent uses.
    await _pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
          CREATE ROLE chemclaw_app NOSUPERUSER NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
          CREATE ROLE chemclaw_service NOSUPERUSER NOLOGIN BYPASSRLS;
        END IF;
      END
      $$
    `);

    // ---- Apply only the schema files the integration tests touch. ----
    const dbInitDir = resolve(repoRoot, "db", "init");
    const filesToApply = [
      "13_agent_sessions.sql",
      "14_agent_session_extensions.sql",
    ];
    for (const file of filesToApply) {
      const sql = readFileSync(resolve(dbInitDir, file), "utf8");
      try {
        await _pool.query(sql);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[testcontainer] ${file} failed: ${(err as Error).message.slice(0, 240)}`,
        );
        throw err;
      }
    }

    return { pool: _pool, container: _container };
  } catch (err) {
    _startupError = err as Error;
    // If startup fails (e.g. Docker not running), surface it so the test
    // can decide whether to skip. We don't try to recover.
    throw err;
  }
}

/** Tear down the shared container + pool. Idempotent. */
export async function stopTestPostgres(): Promise<void> {
  if (_pool) {
    try {
      await _pool.end();
    } catch {
      // ignore — container is going away regardless
    }
    _pool = null;
  }
  if (_container) {
    try {
      await _container.stop();
    } catch {
      // ignore — best effort
    }
    _container = null;
  }
  _startupError = null;
}

/**
 * Quick probe for Docker availability. Used by tests to skip gracefully on
 * developer machines without Docker. Cached so repeated calls don't spawn
 * dozens of `docker info` processes.
 *
 * Uses `execFileSync` (not `exec`) because the command + args are static
 * literals — no shell interpolation, no injection surface.
 */
let _dockerAvailable: boolean | null = null;

export async function isDockerAvailable(): Promise<boolean> {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 3000 });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }
  return _dockerAvailable;
}
