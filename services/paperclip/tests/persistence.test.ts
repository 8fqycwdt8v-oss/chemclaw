// Tests for the PaperclipState persistence layer (Phase G #11).
//
// Mocks pg.Pool to capture queries — verifies the writer issues correct
// SQL on /reserve and /release, and that rehydrateDailyUsd composes the
// "userId:YYYY-MM-DD" key shape BudgetManager expects.

import { describe, it, expect, beforeEach } from "vitest";
import { PaperclipState } from "../src/persistence.js";
import type { Pool } from "pg";

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

function makeMockPool() {
  const queries: CapturedQuery[] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      // Mock today's spend lookup so rehydrateDailyUsd has data to return.
      if (sql.includes("SUM(")) {
        return { rows: [{ user_entra_id: "u1", spent: "12.50" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async end() {
      // no-op
    },
  } as unknown as Pool;
  return { pool, queries };
}

describe("PaperclipState", () => {
  let mock: ReturnType<typeof makeMockPool>;
  let state: PaperclipState;

  beforeEach(() => {
    mock = makeMockPool();
    state = new PaperclipState(mock.pool);
  });

  it("recordReserved INSERTs a 'reserved' row with the supplied fields", async () => {
    await state.recordReserved({
      reservationId: "r-1",
      userEntraId: "u1",
      sessionId: "s1",
      estTokens: 1000,
      estUsd: 0.05,
    });
    const insert = mock.queries.find((q) => q.sql.includes("INSERT INTO paperclip_state"));
    expect(insert).toBeDefined();
    expect(insert!.params).toEqual(["r-1", "u1", "s1", 1000, 0.05]);
  });

  it("recordReleased UPDATEs status='released' with the supplied actuals", async () => {
    await state.recordReleased("r-1", 950, 0.048);
    const update = mock.queries.find((q) => q.sql.includes("UPDATE paperclip_state"));
    expect(update).toBeDefined();
    // Params: actualTokens, actualUsd, reservationId.
    expect(update!.params).toEqual([950, 0.048, "r-1"]);
  });

  it("rehydrateDailyUsd returns today's spend keyed by 'userId:YYYY-MM-DD'", async () => {
    const map = await state.rehydrateDailyUsd();
    expect(map.size).toBeGreaterThanOrEqual(1);
    const todayKey = [...map.keys()][0];
    expect(todayKey).toMatch(/^u1:\d{4}-\d{2}-\d{2}$/);
    expect(map.get(todayKey)).toBeCloseTo(12.5);
  });

  it("recordReserved swallows DB errors so a Postgres outage doesn't break /reserve", async () => {
    const failingPool = {
      async query() {
        throw new Error("connection refused");
      },
    } as unknown as Pool;
    const failingState = new PaperclipState(failingPool);
    // Must not throw.
    await expect(
      failingState.recordReserved({
        reservationId: "r-x",
        userEntraId: "u1",
        sessionId: "s1",
        estTokens: 100,
        estUsd: 0.01,
      }),
    ).resolves.toBeUndefined();
  });
});
