// review-v2 Cycle-1 regression test: createTodos must use a single
// atomic INSERT statement instead of the prior SELECT MAX → loop INSERT
// pattern. The race-prone pattern allowed two parallel turns on the
// same session_id to compute the same nextOrdering and both succeed,
// producing duplicate (session_id, ordering) rows. The unique index
// added in init/19 is the runtime defense; this test pins the
// implementation contract so a future refactor can't quietly revert
// to the looped version.

import { describe, it, expect, vi } from "vitest";
import { createTodos } from "../../src/core/session-store.js";
import type { Pool } from "pg";

describe("createTodos — atomic single-INSERT (review-v2 cycle-1)", () => {
  it("issues exactly one query against the client (not a SELECT-then-loop pattern)", async () => {
    const queries: Array<{ text: string }> = [];
    const fakeClient = {
      query: vi.fn().mockImplementation(async (text: string) => {
        queries.push({ text });
        // Only the INSERT-INTO-agent_todos statement returns todo rows;
        // the framing statements (BEGIN / set_config / COMMIT) return
        // empty rowsets, matching the real Postgres protocol.
        if (text.includes("INSERT INTO agent_todos")) {
          return await Promise.resolve({
            rows: [
              {
                id: "11111111-1111-1111-1111-111111111111",
                ordering: 1,
                content: "first",
                status: "pending",
                created_at: new Date(),
                updated_at: new Date(),
              },
              {
                id: "22222222-2222-2222-2222-222222222222",
                ordering: 2,
                content: "second",
                status: "pending",
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
          });
        }
        return await Promise.resolve({ rows: [] });
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(fakeClient),
    } as unknown as Pool;

    const todos = await createTodos(pool, "u@x", "00000000-0000-0000-0000-000000000001", ["first", "second"]);

    expect(todos).toHaveLength(2);
    expect(todos[0]?.ordering).toBe(1);
    expect(todos[1]?.ordering).toBe(2);

    // Filter out withUserContext's framing: BEGIN / set_config / COMMIT.
    const dataQueries = queries.filter((q) => {
      const t = q.text.trim();
      return (
        !t.toUpperCase().startsWith("BEGIN") &&
        !t.toUpperCase().startsWith("COMMIT") &&
        !t.includes("set_config")
      );
    });

    // The whole atomic-batch contract: createTodos issues exactly one
    // data-touching statement. The prior MAX+loop pattern issued
    // 1 SELECT + N INSERTs (3 for two todos).
    expect(dataQueries).toHaveLength(1);
    // And it's a CTE-based INSERT, not a bare SELECT MAX.
    expect(dataQueries[0]!.text).toContain("WITH max_ord AS");
    expect(dataQueries[0]!.text).toContain("INSERT INTO agent_todos");
    expect(dataQueries[0]!.text).toContain("unnest(");
  });

  it("returns an empty array for an empty contents batch (no DB roundtrip)", async () => {
    const fakeClient = {
      query: vi.fn(),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(fakeClient),
    } as unknown as Pool;

    const todos = await createTodos(pool, "u@x", "00000000-0000-0000-0000-000000000001", []);

    expect(todos).toEqual([]);
    // Empty contents short-circuits before withUserContext even runs.
    expect(pool.connect).not.toHaveBeenCalled();
    expect(fakeClient.query).not.toHaveBeenCalled();
  });
});
