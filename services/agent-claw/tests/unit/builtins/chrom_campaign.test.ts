// Tests for Phase Z6 chromatography-optimization builtins.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildStartChromCampaignTool } from "../../../src/tools/builtins/start_chrom_campaign.js";
import { buildRecommendNextChromBatchTool } from "../../../src/tools/builtins/recommend_next_chrom_batch.js";
import { buildMaterializeChromMethodTool } from "../../../src/tools/builtins/materialize_chrom_method.js";
import { buildQueryChromColumnsTool } from "../../../src/tools/builtins/query_chrom_columns.js";

const URL_ = "http://mcp-chrom-method-optimizer:8019";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

interface PoolOpts {
  resolvedNceProjectId?: string;
  campaignRow?: { id: string; campaign_name: string; status: string } | null;
  campaignSelect?: { bofire_domain: unknown; status: string }[];
  rounds?: { measured_outcomes: unknown; round_index: number }[];
  insertRoundId?: string;
  roundLookup?: { campaign_id: string; proposals: unknown; nce_project_id: string }[];
  columnLookup?: { id: string }[];
  insertedMethodId?: string;
  columnInventoryRows?: unknown[];
}

function makePoolMock(opts: PoolOpts) {
  const queries: { sql: string; params: unknown[] | undefined }[] = [];
  const queryFn = vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes("nce_projects WHERE internal_id")) {
      return {
        rows: opts.resolvedNceProjectId !== undefined
          ? [{ id: opts.resolvedNceProjectId }]
          : [],
      };
    }
    if (sql.includes("INSERT INTO optimization_campaigns")) {
      return { rows: opts.campaignRow ? [opts.campaignRow] : [] };
    }
    if (sql.includes("FROM optimization_campaigns") && sql.includes("WHERE id")) {
      return { rows: opts.campaignSelect ?? [] };
    }
    if (sql.includes("FROM optimization_rounds") && sql.includes("ORDER BY round_index")) {
      return { rows: opts.rounds ?? [] };
    }
    if (sql.includes("INSERT INTO optimization_rounds")) {
      return { rows: [{ id: opts.insertRoundId ?? "11111111-2222-3333-4444-555555555555" }] };
    }
    if (
      sql.includes("FROM optimization_rounds r")
      && sql.includes("JOIN optimization_campaigns")
    ) {
      return { rows: opts.roundLookup ?? [] };
    }
    if (sql.includes("FROM column_inventory") && sql.includes("active = true")) {
      // start_chrom_campaign and materialize_chrom_method both probe column_inventory;
      // the materialize path filters by id while query_chrom_columns lists.
      if (sql.includes("WHERE id::text")) {
        return { rows: opts.columnLookup ?? [] };
      }
      return { rows: opts.columnInventoryRows ?? [] };
    }
    if (sql.includes("INSERT INTO analytical_methods")) {
      return { rows: [{ id: opts.insertedMethodId ?? "ddddeeee-1111-2222-3333-444455556666" }] };
    }
    return { rows: [] };
  });
  return {
    connect: vi.fn(async () => ({ query: queryFn, release: vi.fn() })),
    queries,
  };
}

afterEach(() => vi.unstubAllGlobals());


describe("start_chrom_campaign", () => {
  const VALID_INPUT = {
    campaign_name: "method-dev-1",
    nce_project_internal_id: "PRJ-1",
    gradient_scheme: "hold_ramp_hold" as const,
    columns: [
      { id: "00000000-0000-0000-0000-000000000001", tanaka: [3.3, 1.48, 1.5, 0.42, 0.19, 0.29] as [number, number, number, number, number, number] },
      { id: "00000000-0000-0000-0000-000000000002", tanaka: [3.2, 1.48, 1.51, 0.46, 0.14, 0.31] as [number, number, number, number, number, number] },
    ],
    b_solvent_choices: ["MeCN", "MeOH"],
    additive_choices: ["FA_0.1pct"],
    flow_bounds_mLmin: [0.2, 0.6] as [number, number],
    T_bounds_C: [25.0, 50.0] as [number, number],
    objective_mode: "single" as const,
  };

  it("builds Domain via MCP and inserts campaign row", async () => {
    const pool = makePoolMock({
      resolvedNceProjectId: "00000000-0000-0000-0000-000000000010",
      campaignRow: {
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        campaign_name: "method-dev-1",
        status: "active",
      },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        bofire_domain: { type: "Domain" },
        n_inputs: 10,
        n_outputs: 1,
        gradient_scheme: "hold_ramp_hold",
        objective_mode: "single",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildStartChromCampaignTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), VALID_INPUT);

    expect(result.campaign_id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(result.n_inputs).toBe(10);
    expect(result.gradient_scheme).toBe("hold_ramp_hold");
    expect(result.objective_mode).toBe("single");

    // Confirm the MCP call payload carried the columns + descriptors.
    const call = fetchMock.mock.calls[0]!;
    const body = JSON.parse((call[1] as { body: string }).body);
    expect(body.column_choices).toEqual([
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
    ]);
    expect(body.column_descriptors[0]).toHaveLength(6);
  });

  it("translates objective_mode=pareto into MoboStrategy + qNEHVI on the persisted row", async () => {
    const pool = makePoolMock({
      resolvedNceProjectId: "00000000-0000-0000-0000-000000000010",
      campaignRow: { id: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee", campaign_name: "x", status: "active" },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        bofire_domain: {},
        n_inputs: 10,
        n_outputs: 3,
        gradient_scheme: "hold_ramp_hold",
        objective_mode: "pareto",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildStartChromCampaignTool(pool as never, URL_);
    await tool.execute(makeCtx(), { ...VALID_INPUT, objective_mode: "pareto" });

    const insertCall = pool.queries.find((q) => q.sql.includes("INSERT INTO optimization_campaigns"));
    expect(insertCall).toBeDefined();
    const params = insertCall!.params as unknown[];
    // params: [nceProjectId, campaign_name, campaign_type, strategy, acquisition, ...]
    expect(params[2]).toBe("multi_objective");
    expect(params[3]).toBe("MoboStrategy");
    expect(params[4]).toBe("qNEHVI");
  });

  it("rejects when project resolves empty (RLS-filtered or absent)", async () => {
    const pool = makePoolMock({});
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        bofire_domain: {}, n_inputs: 1, n_outputs: 1,
        gradient_scheme: "hold_ramp_hold", objective_mode: "single",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const tool = buildStartChromCampaignTool(pool as never, URL_);
    await expect(tool.execute(makeCtx(), VALID_INPUT))
      .rejects.toThrow(/nce_project_not_found_or_forbidden/);
  });
});


describe("recommend_next_chrom_batch", () => {
  it("cold-start path with 0 prior rounds returns random proposals", async () => {
    const pool = makePoolMock({
      campaignSelect: [{ bofire_domain: { type: "Domain" }, status: "active" }],
      rounds: [],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        proposals: [
          { factor_values: { pctB_init: 5, t_grad_min: 8 }, source: "random_cold_start" },
        ],
        n_observations: 0,
        used_bo: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildRecommendNextChromBatchTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), {
      campaign_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      n_candidates: 1,
      seed: 42,
    });

    expect(result.used_bo).toBe(false);
    expect(result.round_index).toBe(0);
    expect(result.proposals[0]!.source).toBe("random_cold_start");
  });

  it("warm-BO path with 5 prior outcomes flattens measured rows into MCP call", async () => {
    const pool = makePoolMock({
      campaignSelect: [{ bofire_domain: {}, status: "active" }],
      rounds: [
        {
          round_index: 0,
          measured_outcomes: [
            { factor_values: { pctB_init: 5 }, outputs: { crf_total: 0.4 } },
            { factor_values: { pctB_init: 10 }, outputs: { crf_total: 0.5 } },
            { factor_values: { pctB_init: 15 }, outputs: { crf_total: 0.6 } },
          ],
        },
        {
          round_index: 1,
          measured_outcomes: [
            { factor_values: { pctB_init: 20 }, outputs: { crf_total: 0.7 } },
            { factor_values: { pctB_init: 25 }, outputs: { crf_total: 0.8 } },
          ],
        },
      ],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        proposals: [{ factor_values: { pctB_init: 12 }, source: "qLogEI" }],
        n_observations: 5,
        used_bo: true,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildRecommendNextChromBatchTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), {
      campaign_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      n_candidates: 1,
      seed: 0,
    });

    expect(result.used_bo).toBe(true);
    expect(result.n_observations).toBe(5);
    expect(result.round_index).toBe(2);
    const fetchCall = fetchMock.mock.calls[0]!;
    const body = JSON.parse((fetchCall[1] as { body: string }).body);
    expect(body.measured_outcomes).toHaveLength(5);
  });

  it("rejects on inactive campaign", async () => {
    const pool = makePoolMock({
      campaignSelect: [{ bofire_domain: {}, status: "completed" }],
      rounds: [],
    });
    const tool = buildRecommendNextChromBatchTool(pool as never, URL_);
    await expect(
      tool.execute(makeCtx(), {
        campaign_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        n_candidates: 1,
        seed: 0,
      }),
    ).rejects.toThrow(/campaign_not_active:completed/);
  });
});


describe("materialize_chrom_method", () => {
  it("compiles a proposal and inserts an analytical_methods row", async () => {
    const pool = makePoolMock({
      roundLookup: [{
        campaign_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        nce_project_id: "00000000-0000-0000-0000-000000000010",
        proposals: [
          {
            factor_values: {
              t_hold_init_min: 0.5,
              pctB_init: 5,
              t_grad_min: 8,
              pctB_final: 95,
              t_hold_final_min: 1.5,
              column: "00000000-0000-0000-0000-000000000001",
              b_solvent: "MeCN",
              additive: "FA_0.1pct",
              flow_mLmin: 0.4,
              T_col_C: 40,
            },
            source: "qLogEI",
          },
        ],
      }],
      columnLookup: [{ id: "00000000-0000-0000-0000-000000000001" }],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        technique: "RP-UHPLC",
        column: "00000000-0000-0000-0000-000000000001",
        b_solvent: "MeCN",
        additive: "FA_0.1pct",
        flow_mLmin: 0.4,
        T_col_C: 40,
        detection_mode: "DAD",
        gradient_program: [
          { time_min: 0.0,  pctB:  5.0 },
          { time_min: 0.5,  pctB:  5.0 },
          { time_min: 8.5,  pctB: 95.0 },
          { time_min: 10.0, pctB: 95.0 },
        ],
        total_runtime_min: 10.0,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildMaterializeChromMethodTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), {
      round_id: "11111111-2222-3333-4444-555555555555",
      proposal_index: 0,
      method_name: "method-dev-round-1-A",
      detection_mode: "DAD",
      technique: "RP-UHPLC",
      gradient_scheme: "hold_ramp_hold",
      injection_volume_uL: 2.0,
    });

    expect(result.method_id).toBe("ddddeeee-1111-2222-3333-444455556666");
    expect(result.total_runtime_min).toBe(10.0);
    expect(result.gradient_program).toHaveLength(4);
  });

  it("rejects out-of-range proposal_index", async () => {
    const pool = makePoolMock({
      roundLookup: [{
        campaign_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        nce_project_id: "00000000-0000-0000-0000-000000000010",
        proposals: [],
      }],
    });
    const tool = buildMaterializeChromMethodTool(pool as never, URL_);
    await expect(tool.execute(makeCtx(), {
      round_id: "11111111-2222-3333-4444-555555555555",
      proposal_index: 5,
      method_name: "x",
      detection_mode: "DAD",
      technique: "RP-UHPLC",
      gradient_scheme: "hold_ramp_hold",
      injection_volume_uL: 2.0,
    })).rejects.toThrow(/proposal_index_out_of_range/);
  });

  it("rejects when the round is not visible (RLS-filtered)", async () => {
    const pool = makePoolMock({ roundLookup: [] });
    const tool = buildMaterializeChromMethodTool(pool as never, URL_);
    await expect(tool.execute(makeCtx(), {
      round_id: "11111111-2222-3333-4444-555555555555",
      proposal_index: 0,
      method_name: "x",
      detection_mode: "DAD",
      technique: "RP-UHPLC",
      gradient_scheme: "hold_ramp_hold",
      injection_volume_uL: 2.0,
    })).rejects.toThrow(/round_not_found/);
  });
});


describe("query_chrom_columns", () => {
  function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "00000000-0000-0000-0000-000000000001",
      vendor: "Waters",
      product_line: "Acquity BEH",
      chemistry: "C18",
      particle_size_um: "1.70",
      pore_size_A: 130,
      dimensions_mm: "2.1x50",
      tanaka_kPB: "3.30",
      tanaka_alphaCH2: "1.480",
      tanaka_alphaT_O: "1.500",
      tanaka_alphaC_P: "0.420",
      tanaka_alphaB_P_pH27: "0.190",
      tanaka_alphaB_P_pH76: "0.290",
      pH_min: "1.0",
      pH_max: "12.0",
      T_max_C: "80.0",
      flow_max_mLmin: "1.00",
      pressure_max_bar: 1034,
      is_msc: true,
      active: true,
      ...over,
    };
  }

  it("returns parsed Tanaka vectors for active columns", async () => {
    const pool = makePoolMock({
      columnInventoryRows: [makeRow()],
    });
    const tool = buildQueryChromColumnsTool(pool as never);
    const result = await tool.execute(makeCtx(), {
      require_ms_compatible: false,
      include_inactive: false,
      limit: 10,
    });
    expect(result.n_total).toBe(1);
    const row = result.columns[0]!;
    expect(row.tanaka).toEqual([3.30, 1.480, 1.500, 0.420, 0.190, 0.290]);
    expect(row.is_msc).toBe(true);
  });

  it("filters out columns missing any Tanaka descriptor", async () => {
    const pool = makePoolMock({
      columnInventoryRows: [
        makeRow(),
        makeRow({
          id: "00000000-0000-0000-0000-000000000099",
          tanaka_alphaB_P_pH76: null,
        }),
      ],
    });
    const tool = buildQueryChromColumnsTool(pool as never);
    const result = await tool.execute(makeCtx(), {
      require_ms_compatible: false,
      include_inactive: false,
      limit: 10,
    });
    expect(result.n_total).toBe(1);
    expect(result.columns[0]!.id).toBe("00000000-0000-0000-0000-000000000001");
  });
});
