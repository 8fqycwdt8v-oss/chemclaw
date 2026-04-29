// Integration test: etag optimistic-lock against a real Postgres.
//
// Phase 8 of the harness control-plane rebuild plan, task 8.2. Locks in the
// behaviour that a stale `expectedEtag` on `saveSession` raises
// OptimisticLockError instead of silently overwriting a concurrent update.
// The unit-test version of this lives in tests/unit/session-store.test.ts
// and uses a mock pool — this test rebuilds it against a live Postgres
// running the real schema (incl. the etag-regen trigger from
// db/init/14_agent_session_extensions.sql).
//
// Skips when Docker isn't available so developer machines without Docker
// stay green. CI runs Docker so the suite asserts the real path.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import {
  startTestPostgres,
  stopTestPostgres,
  isDockerAvailable,
} from "../helpers/postgres-container.js";
import {
  saveSession,
  loadSession,
  OptimisticLockError,
} from "../../src/core/session-store.js";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)(
  "agent_sessions etag optimistic lock (integration)",
  () => {
    let pool: Pool;
    const userId = "etag-test-user@example.com";

    beforeAll(async () => {
      ({ pool } = await startTestPostgres(repoRoot));
    }, 180_000);

    afterAll(async () => {
      await stopTestPostgres();
    });

    it("saveSession with a stale expectedEtag throws OptimisticLockError", async () => {
      // Insert a fresh session row directly. We bypass withUserContext here
      // because we own the test setup — RLS is checked separately by the
      // saveSession call below.
      const insertResult = await pool.query<{ id: string; etag: string }>(
        `INSERT INTO agent_sessions (user_entra_id)
         VALUES ($1)
         RETURNING id::text AS id, etag::text AS etag`,
        [userId],
      );
      const sessionId = insertResult.rows[0]!.id;
      const originalEtag = insertResult.rows[0]!.etag;

      // Simulate a concurrent writer bumping a column the etag-regen trigger
      // tracks (message_count is in the trigger's IS DISTINCT FROM list).
      // After this UPDATE the row's etag is a different UUID.
      await pool.query(
        `UPDATE agent_sessions
            SET message_count = message_count + 1
          WHERE id = $1::uuid`,
        [sessionId],
      );

      // Confirm the trigger really did regenerate etag — otherwise the test
      // is meaningless.
      const after = await pool.query<{ etag: string }>(
        `SELECT etag::text AS etag FROM agent_sessions WHERE id = $1::uuid`,
        [sessionId],
      );
      expect(after.rows[0]!.etag).not.toBe(originalEtag);

      // Now try to save with the stale etag — the WHERE clause won't match,
      // RETURNING produces zero rows, and saveSession throws.
      await expect(
        saveSession(pool, userId, sessionId, {
          lastFinishReason: "stop",
          expectedEtag: originalEtag,
        }),
      ).rejects.toBeInstanceOf(OptimisticLockError);

      // The session is still loadable + reflects the concurrent writer,
      // not the failed saveSession call.
      const loaded = await loadSession(pool, userId, sessionId);
      expect(loaded).not.toBeNull();
      expect(loaded!.messageCount).toBe(1);
      expect(loaded!.lastFinishReason).toBeNull();
    });

    it("saveSession with the matching etag succeeds and rotates the etag", async () => {
      const insertResult = await pool.query<{ id: string; etag: string }>(
        `INSERT INTO agent_sessions (user_entra_id)
         VALUES ($1)
         RETURNING id::text AS id, etag::text AS etag`,
        [userId],
      );
      const sessionId = insertResult.rows[0]!.id;
      const originalEtag = insertResult.rows[0]!.etag;

      const { etag: newEtag } = await saveSession(pool, userId, sessionId, {
        lastFinishReason: "stop",
        expectedEtag: originalEtag,
      });

      expect(newEtag).not.toBe(originalEtag);

      const loaded = await loadSession(pool, userId, sessionId);
      expect(loaded!.lastFinishReason).toBe("stop");
      expect(loaded!.etag).toBe(newEtag);
    });
  },
);
