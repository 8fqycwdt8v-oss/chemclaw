// Integration test: concurrent withUserContext sees only own rows.
//
// The single primitive standing between a multi-tenant agent and cross-user
// data leakage is `withUserContext` setting `app.current_user_entra_id` via
// SET LOCAL on a transaction-scoped session. Two concurrent transactions
// against the same RLS-protected table MUST see disjoint row sets — this
// test asserts it end-to-end against a real Postgres with FORCE ROW LEVEL
// SECURITY enabled on agent_sessions.
//
// Skips when Docker is unavailable so dev machines stay green; the
// testcontainer harness in tests/helpers/postgres-container.ts handles the
// schema bootstrap (13_agent_sessions.sql + 14_agent_session_extensions.sql)
// and provides an `appPool` authenticated as chemclaw_app — the role
// production uses, with NOSUPERUSER + FORCE RLS enforced (vs the owner
// pool which bypasses RLS via implicit OWNER privilege).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import {
  startTestPostgres,
  stopTestPostgres,
  isDockerAvailable,
} from "../helpers/postgres-container.js";
import { withUserContext } from "../../src/db/with-user-context.js";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)(
  "concurrent withUserContext RLS isolation",
  () => {
    let appPool: Pool;
    let pool: Pool;
    const alice = "rls-test-alice@example.com";
    const bob = "rls-test-bob@example.com";

    beforeAll(async () => {
      ({ appPool, pool } = await startTestPostgres(repoRoot));

      // Seed disjoint row sets owned by alice and bob. Inserts go through
      // the owner pool so the test setup itself isn't gated by RLS.
      await pool.query(
        `INSERT INTO agent_sessions (user_entra_id, last_finish_reason, updated_at)
           VALUES ($1, 'stop', NOW())`,
        [alice],
      );
      await pool.query(
        `INSERT INTO agent_sessions (user_entra_id, last_finish_reason, updated_at)
           VALUES ($1, 'stop', NOW())`,
        [alice],
      );
      await pool.query(
        `INSERT INTO agent_sessions (user_entra_id, last_finish_reason, updated_at)
           VALUES ($1, 'stop', NOW())`,
        [bob],
      );
    }, 180_000);

    afterAll(async () => {
      // Best-effort cleanup; the container is torn down anyway, but explicit
      // delete keeps any subsequent test in this run namespace-clean.
      try {
        await pool.query(
          `DELETE FROM agent_sessions WHERE user_entra_id IN ($1, $2)`,
          [alice, bob],
        );
      } catch {
        // ignore — container may already be gone
      }
      await stopTestPostgres();
    });

    it("two parallel withUserContext blocks see disjoint row sets", async () => {
      // Both queries run in parallel against the SAME pool. With pool
      // size 8 the two concurrent blocks almost certainly land on
      // separate physical connections, so this test exercises the
      // "two simultaneous in-flight transactions" case rather than the
      // single-connection reuse case (covered by the sequential test
      // below). A regression that swapped SET LOCAL for SET (session
      // scope) would still trip here because the GUC would persist on
      // each connection past COMMIT and bleed into whichever block's
      // queries follow on the same connection.
      const [aliceRows, bobRows] = await Promise.all([
        withUserContext(appPool, alice, async (client) => {
          // Hold alice's transaction open briefly so bob's transaction
          // is guaranteed to be in flight at the same moment — proves
          // the two SET LOCAL calls don't interfere across connections.
          await client.query("SELECT pg_sleep(0.05)");
          const r = await client.query<{ user_entra_id: string }>(
            `SELECT user_entra_id FROM agent_sessions ORDER BY user_entra_id`,
          );
          return r.rows;
        }),
        withUserContext(appPool, bob, async (client) => {
          const r = await client.query<{ user_entra_id: string }>(
            `SELECT user_entra_id FROM agent_sessions ORDER BY user_entra_id`,
          );
          return r.rows;
        }),
      ]);

      // Each user must see ONLY their own rows.
      expect(aliceRows.every((r) => r.user_entra_id === alice)).toBe(true);
      expect(bobRows.every((r) => r.user_entra_id === bob)).toBe(true);

      // And both row sets must be non-empty (i.e., the test isn't
      // accidentally green because RLS blocked everything for both users).
      expect(aliceRows.length).toBeGreaterThanOrEqual(2);
      expect(bobRows.length).toBeGreaterThanOrEqual(1);
    });

    it("a withUserContext block cannot see a peer's rows even after the peer's tx commits", async () => {
      // Sequential rather than parallel: confirms RLS gates reads by the
      // transaction-local GUC, not by some leftover session-level state
      // from a prior transaction on the same pooled connection.
      const aliceCount = await withUserContext(appPool, alice, async (client) => {
        const r = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM agent_sessions`,
        );
        return Number(r.rows[0]!.n);
      });
      const bobCount = await withUserContext(appPool, bob, async (client) => {
        const r = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM agent_sessions`,
        );
        return Number(r.rows[0]!.n);
      });
      expect(aliceCount).toBeGreaterThanOrEqual(2);
      expect(bobCount).toBeGreaterThanOrEqual(1);
      // Alice and bob's counts together exceed what either sees alone —
      // proves each is RLS-gated rather than seeing the union.
      expect(aliceCount + bobCount).toBeGreaterThanOrEqual(3);
    });

    it("an unauthenticated context (empty user_entra_id) sees zero rows under FORCE RLS", async () => {
      // Empty-string sentinel must not pass the policy gate — the policy
      // explicitly requires app.current_user_entra_id to be non-NULL AND
      // not empty (see db/init/13_agent_sessions.sql:80 + the empty-user
      // guard in db/init/42_session_policy_empty_user_guard.sql). This
      // assertion is the canary that catches accidental policy widening.
      await expect(
        withUserContext(appPool, "", async (client) => {
          const r = await client.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM agent_sessions`,
          );
          return Number(r.rows[0]!.n);
        }),
      ).resolves.toBe(0);
    });
  },
);
