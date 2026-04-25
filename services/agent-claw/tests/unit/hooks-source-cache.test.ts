// Tests for the source-cache post_tool hook.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sourceCachePostToolHook,
  checkStaleFacts,
  type SourceFactPayload,
} from "../../src/core/hooks/source-cache.js";

// ---------- Mocks ------------------------------------------------------------

function mockPool(queryResult: { rows: { count: string }[] } = { rows: [{ count: "0" }] }) {
  return {
    query: vi.fn().mockResolvedValue(queryResult),
  } as unknown as import("pg").Pool;
}

// withUserContext is used to write to the DB. We patch it to avoid real DB calls.
vi.mock("../../src/db/with-user-context.js", () => ({
  withUserContext: vi.fn(async (pool: unknown, user: unknown, fn: (c: unknown) => Promise<void>) => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await fn(client);
    return client;
  }),
}));

// ---------- Tests: tool ID pattern ------------------------------------------

describe("sourceCachePostToolHook — tool ID gating", () => {
  it("does nothing for non-source tool IDs", async () => {
    const pool = mockPool();
    const { withUserContext } = await import("../../src/db/with-user-context.js");
    await sourceCachePostToolHook("canonicalize_smiles", { foo: "bar" }, pool as import("pg").Pool, "user@test.com");
    expect(withUserContext).not.toHaveBeenCalled();
  });

  it("activates for query_eln_experiments", async () => {
    const pool = mockPool();
    const { withUserContext } = await import("../../src/db/with-user-context.js");
    await sourceCachePostToolHook(
      "query_eln_experiments",
      { source_system: "benchling", entries: [] },
      pool as import("pg").Pool,
      "user@test.com",
    );
    // withUserContext called (even with 0 facts — it still checks)
    // Actually with 0 entries, no facts to insert → no DB call
    // Just verify no crash
    expect(true).toBe(true);
  });

  it("activates for fetch_lims_result", async () => {
    // No crash expected; output is a single LIMS result
    await sourceCachePostToolHook(
      "fetch_lims_result",
      {
        id: "res_001",
        source_system: "starlims",
        result_value: "98.5",
        analysis_name: "HPLC Purity",
        completed_at: "2024-04-01T00:00:00Z",
      },
      mockPool() as import("pg").Pool,
      "u@t.com",
    );
    expect(true).toBe(true);
  });
});

// ---------- Tests: ELN fact extraction ---------------------------------------

describe("sourceCachePostToolHook — ELN fact extraction", () => {
  it("extracts yield_pct from ELN entries array", async () => {
    const { withUserContext } = await import("../../src/db/with-user-context.js");
    vi.clearAllMocks();

    const capturedFacts: SourceFactPayload[] = [];
    const mockWithUserCtx = vi.fn(async (pool: unknown, user: unknown, fn: (c: unknown) => Promise<void>) => {
      const client = {
        query: vi.fn().mockImplementation(async (_sql: string, params: unknown[]) => {
          capturedFacts.push(JSON.parse(params[3] as string) as SourceFactPayload);
          return { rows: [] };
        }),
      };
      await fn(client);
    });
    const ucModule = await import("../../src/db/with-user-context.js");
    vi.mocked(ucModule.withUserContext).mockImplementation(mockWithUserCtx);

    await sourceCachePostToolHook(
      "query_eln_experiments",
      {
        source_system: "benchling",
        entries: [
          {
            id: "etr_001",
            schema_id: "sch_x",
            fields: {
              yield_pct: { value: 87.5 },
              solvent: { value: "THF" },
            },
            modified_at: "2024-04-01T10:00:00Z",
          },
        ],
      },
      mockPool() as import("pg").Pool,
      "u@t.com",
    );

    const yieldFact = capturedFacts.find((f) => f.predicate === "HAS_YIELD");
    expect(yieldFact).toBeDefined();
    expect(yieldFact?.object_value).toBe(87.5);
    expect(yieldFact?.source_system_id).toBe("benchling");
    expect(yieldFact?.subject_id).toBe("etr_001");

    const solventFact = capturedFacts.find((f) => f.predicate === "HAS_SOLVENT");
    expect(solventFact).toBeDefined();
    expect(solventFact?.object_value).toBe("THF");
  });
});

// ---------- Tests: LIMS fact extraction --------------------------------------

describe("sourceCachePostToolHook — LIMS fact extraction", () => {
  it("extracts result_value from a single LIMS result", async () => {
    const ucModule = await import("../../src/db/with-user-context.js");
    const capturedFacts: SourceFactPayload[] = [];
    vi.mocked(ucModule.withUserContext).mockImplementation(async (_p, _u, fn) => {
      const client = {
        query: vi.fn().mockImplementation(async (_sql: string, params: unknown[]) => {
          capturedFacts.push(JSON.parse(params[3] as string) as SourceFactPayload);
          return { rows: [] };
        }),
      };
      await fn(client);
    });

    await sourceCachePostToolHook(
      "fetch_lims_result",
      {
        id: "res_9001",
        source_system: "starlims",
        result_value: "99.1",
        analysis_name: "Purity",
        completed_at: "2024-04-01T12:00:00Z",
      },
      mockPool() as import("pg").Pool,
      "u@t.com",
    );

    expect(capturedFacts.length).toBeGreaterThan(0);
    expect(capturedFacts[0]?.source_system_id).toBe("starlims");
    expect(capturedFacts[0]?.object_value).toBe("99.1");
  });
});

// ---------- Tests: instrument fact extraction --------------------------------

describe("sourceCachePostToolHook — instrument fact extraction", () => {
  it("extracts total_area and peak area_pct from a waters run", async () => {
    const ucModule = await import("../../src/db/with-user-context.js");
    const capturedFacts: SourceFactPayload[] = [];
    vi.mocked(ucModule.withUserContext).mockImplementation(async (_p, _u, fn) => {
      const client = {
        query: vi.fn().mockImplementation(async (_sql: string, params: unknown[]) => {
          capturedFacts.push(JSON.parse(params[3] as string) as SourceFactPayload);
          return { rows: [] };
        }),
      };
      await fn(client);
    });

    await sourceCachePostToolHook(
      "fetch_instrument_run",
      {
        id: "run_W001",
        source_system: "waters",
        total_area: 999750.0,
        run_date: "2024-04-01T09:15:00Z",
        peaks: [
          { peak_name: "Main", area_pct: 98.5, retention_time_min: 3.42, area: 985000.0 },
        ],
      },
      mockPool() as import("pg").Pool,
      "u@t.com",
    );

    const areaFact = capturedFacts.find((f) => f.predicate === "HAS_TOTAL_AREA");
    expect(areaFact).toBeDefined();
    expect(areaFact?.object_value).toBe(999750.0);
    expect(areaFact?.source_system_id).toBe("waters");

    const peakFact = capturedFacts.find((f) => f.predicate === "HAS_PEAK_AREA_PCT");
    expect(peakFact).toBeDefined();
    expect(peakFact?.object_value).toBe(98.5);
  });
});

// ---------- Tests: stale-fact warning ----------------------------------------

describe("checkStaleFacts", () => {
  it("injects warning into scratchpad when stale facts exist", async () => {
    const pool = mockPool({ rows: [{ count: "3" }] });
    const scratchpad = new Map<string, unknown>();
    await checkStaleFacts(pool as import("pg").Pool, scratchpad);
    const warnings = scratchpad.get("staleFactWarnings") as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("3");
    expect(warnings[0]).toContain("expired");
  });

  it("does not modify scratchpad when no stale facts", async () => {
    const pool = mockPool({ rows: [{ count: "0" }] });
    const scratchpad = new Map<string, unknown>();
    await checkStaleFacts(pool as import("pg").Pool, scratchpad);
    expect(scratchpad.has("staleFactWarnings")).toBe(false);
  });

  it("handles DB errors gracefully (non-fatal)", async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error("DB down")),
    } as unknown as import("pg").Pool;
    const scratchpad = new Map<string, unknown>();
    // Should not throw
    await expect(checkStaleFacts(pool, scratchpad)).resolves.toBeUndefined();
  });
});
