// Tests for buildStatisticalAnalyzeTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildStatisticalAnalyzeTool } from "../../../src/tools/builtins/statistical_analyze.js";
import { mockPool } from "../../helpers/mock-pg.js";
import { makeCtx } from "../../helpers/make-ctx.js";

const MCP_TABICL_URL = "http://mcp-tabicl:8005";

const REACTION_IDS = [
  "aaaaaaaa-0000-0000-0000-000000000001",
  "aaaaaaaa-0000-0000-0000-000000000002",
  "aaaaaaaa-0000-0000-0000-000000000003",
  "aaaaaaaa-0000-0000-0000-000000000004",
  "aaaaaaaa-0000-0000-0000-000000000005",
];

const COMPARE_CONDITION_ROWS = [
  { bucket_label: "DCM·5", n: 12, mean_yield: 82.5, median_yield: 83.0, p25: 78.0, p75: 87.0 },
];

function mockFetchTabicl(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify(body),
  } as Response);
}

function makeReactionDbRows(ids: string[]) {
  return ids.map((id) => ({
    reaction_id: id,
    rxn_smiles: "CC>>CCC",
    rxno_class: "coupling",
    temp_c: "80",
    time_min: "60",
    solvent: "DCM",
    catalyst_loading_mol_pct: "5",
    base: null,
    yield_pct: "85",
  }));
}

describe("buildStatisticalAnalyzeTool — compare_conditions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns condition_comparison without calling ML service", async () => {
    // No fetch needed for compare_conditions — guard against accidental calls
    const guardFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "should not call",
    } as unknown as Response);
    vi.stubGlobal("fetch", guardFetch);

    const { pool, client } = mockPool();
    client.queryResults.push(
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [], rowCount: 0 }, // set_config
      { rows: COMPARE_CONDITION_ROWS, rowCount: 1 },
      { rows: [], rowCount: 0 }, // COMMIT
    );

    const tool = buildStatisticalAnalyzeTool(pool, MCP_TABICL_URL);
    const result = await tool.execute(makeCtx(), {
      reaction_ids: REACTION_IDS,
      question: "compare_conditions",
    });

    expect(result.task).toBe("regression");
    expect(result.condition_comparison).toHaveLength(1);
    expect(result.condition_comparison![0]!.bucket_label).toBe("DCM·5");
    expect(guardFetch).not.toHaveBeenCalled();
  });
});

describe("buildStatisticalAnalyzeTool — rank_feature_importance", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls featurize then predict_and_rank and returns feature_importance", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            rows: [[1, 2, 3], [4, 5, 6]],
            targets: [85, 72],
            feature_names: ["temp_c", "time_min", "solvent"],
            categorical_names: ["solvent"],
            skipped: [],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            predictions: [80, 75],
            prediction_std: [2.1, 1.8],
            feature_importance: { temp_c: 0.45, time_min: 0.30, solvent: 0.25 },
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { pool, client } = mockPool();
    // loadReactionRows (BEGIN, set_config, SELECT, COMMIT)
    client.queryResults.push(
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: makeReactionDbRows(REACTION_IDS), rowCount: 5 },
      { rows: [], rowCount: 0 },
    );

    const tool = buildStatisticalAnalyzeTool(pool, MCP_TABICL_URL);
    const result = await tool.execute(makeCtx(), {
      reaction_ids: REACTION_IDS,
      question: "rank_feature_importance",
    });

    expect(result.feature_importance).toBeDefined();
    expect(result.feature_importance![0]?.feature).toBe("temp_c"); // highest importance first
    expect(result.support_size).toBeGreaterThan(0);
  });

  it("returns empty support warning when featurize returns no targets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            rows: [],
            targets: [],
            feature_names: [],
            categorical_names: [],
            skipped: [],
          }),
      }),
    );

    const { pool, client } = mockPool();
    client.queryResults.push(
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    );

    const tool = buildStatisticalAnalyzeTool(pool, MCP_TABICL_URL);
    const result = await tool.execute(makeCtx(), {
      reaction_ids: REACTION_IDS,
      question: "rank_feature_importance",
    });

    expect(result.support_size).toBe(0);
    expect(result.caveats.some((c) => c.includes("no usable support rows"))).toBe(true);
  });

  it("inputSchema rejects fewer than 5 reaction_ids", () => {
    const { pool } = mockPool();
    const tool = buildStatisticalAnalyzeTool(pool, MCP_TABICL_URL);
    const r = tool.inputSchema.safeParse({
      reaction_ids: REACTION_IDS.slice(0, 4),
      question: "compare_conditions",
    });
    expect(r.success).toBe(false);
  });
});
