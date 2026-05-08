// Tests for classifyAutoResumeFailure.
//
// The function distinguishes "actually at the auto-resume cap" from
// "another caller is mid-resume" when the atomic UPDATE in
// tryIncrementAutoResumeCount returns null. The heuristic is:
// updated_at moved within `windowSeconds` → in_progress; otherwise
// cap_reached. Tests stub the pg.Pool client so they don't need
// testcontainer infra.

import { describe, it, expect, vi } from "vitest";
import { classifyAutoResumeFailure } from "../../src/core/session-store.js";

function makeMockPool(rowsFromQuery: Array<Record<string, unknown>>) {
  // Replicate the minimum withUserContext surface: BEGIN, SET LOCAL,
  // arbitrary query, COMMIT. We only care about the SELECT response.
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith("BEGIN")) return { rows: [] };
      if (sql.startsWith("SELECT set_config")) return { rows: [] };
      if (sql.startsWith("COMMIT")) return { rows: [] };
      if (sql.includes("recently_active")) {
        return { rows: rowsFromQuery };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
  };
  return { pool: pool as never, client };
}

describe("classifyAutoResumeFailure", () => {
  it("returns 'in_progress' when updated_at is recent", async () => {
    const { pool } = makeMockPool([{ recently_active: true }]);
    const result = await classifyAutoResumeFailure(pool, "u@x", "session-1");
    expect(result).toBe("in_progress");
  });

  it("returns 'cap_reached' when updated_at is stale", async () => {
    const { pool } = makeMockPool([{ recently_active: false }]);
    const result = await classifyAutoResumeFailure(pool, "u@x", "session-1");
    expect(result).toBe("cap_reached");
  });

  it("defaults to 'cap_reached' when the row is missing", async () => {
    // Defensive fallback — if the session row vanished mid-flight (e.g.
    // TTL purge), we surface cap_reached rather than spuriously claiming
    // in_progress (which would imply we should retry).
    const { pool } = makeMockPool([]);
    const result = await classifyAutoResumeFailure(pool, "u@x", "session-1");
    expect(result).toBe("cap_reached");
  });

  it("passes the configured window to the SQL query", async () => {
    const { pool, client } = makeMockPool([{ recently_active: true }]);
    await classifyAutoResumeFailure(pool, "u@x", "session-1", 60);

    // Find the SELECT call.
    const selectCall = (client.query.mock.calls as Array<[string, unknown[]?]>).find(
      ([sql]) => sql.includes("recently_active"),
    );
    expect(selectCall).toBeDefined();
    expect(selectCall?.[1]).toEqual(["session-1", 60]);
  });
});
