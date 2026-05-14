// Tests for Z5 closed-loop optimization builtins.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildStartOptimizationCampaignTool } from "../../../src/tools/builtins/start_optimization_campaign.js";
import { buildRecommendNextBatchTool } from "../../../src/tools/builtins/recommend_next_batch.js";
import { buildIngestCampaignResultsTool } from "../../../src/tools/builtins/ingest_campaign_results.js";
import type { ConfigRegistry } from "../../../src/config/registry.js";

const URL_ = "http://mcp-reaction-optimizer:8018";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

// Stub ConfigRegistry: returns the provided default. The real one would
// hit Postgres; the recommend_next_batch tests don't care about the value
// and only assert that the BO loop wires up correctly.
function stubConfigRegistry(): ConfigRegistry {
  return {
    get: async <T>(_k: string, _ctx: unknown, def: T) => def,
    getNumber: async (_k: string, _ctx: unknown, def: number) => def,
    getBoolean: async (_k: string, _ctx: unknown, def: boolean) => def,
    getString: async (_k: string, _ctx: unknown, def: string) => def,
    invalidate: () => undefined,
  } as unknown as ConfigRegistry;
}

interface PoolMockOpts {
  buildDomainResponse?: unknown;
  resolvedNceProjectId?: string;
  /** synthesis_campaigns visibility check return; provide [{ id }] to allow */
  synthesisCampaignVisibleId?: string;
  campaignRow?: { id: string; campaign_name: string; status: string } | null;
  /** New shape: includes strategy, acquisition, seed, nce_project_id. */
  campaignSelect?: Array<{
    bofire_domain: unknown;
    status: string;
    strategy?: string;
    acquisition?: string;
    seed?: number | null;
    nce_project_id?: string;
  }>;
  rounds?: { measured_outcomes: unknown; round_index: number }[];
  insertRoundId?: string;
  /** Used by ingest_campaign_results: the JOIN-back select that the new tool runs. */
  ingestCampaignDomain?: Array<{
    campaign_id: string;
    bofire_domain: unknown;
    output_bounds?: unknown;
    synthesis_campaign_id?: string | null;
  }>;
  /** UPDATE optimization_rounds RETURNING. */
  ingestRow?: { campaign_id: string; ingested_results_at: string };
  /** Existence row returned by the post-update sentinel SELECT. */
  ingestExistsRow?: { ingested_results_at: string | null };
  /** synthesis_campaign_steps backfill returns. Provide [{id}] for a hit. */
  ingestStepUpdate?: Array<{ id: string }>;
}

function makePoolMock(opts: PoolMockOpts) {
  const queries: string[] = [];
  const queryFn = vi.fn(async (sql: string, _params?: unknown[]) => {
    queries.push(sql);
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("nce_projects WHERE internal_id")) {
      return {
        rows:
          opts.resolvedNceProjectId !== undefined
            ? [{ id: opts.resolvedNceProjectId }]
            : [],
      };
    }
    if (sql.includes("FROM synthesis_campaigns")) {
      return {
        rows:
          opts.synthesisCampaignVisibleId !== undefined
            ? [{ id: opts.synthesisCampaignVisibleId }]
            : [],
      };
    }
    if (sql.includes("INSERT INTO optimization_campaigns")) {
      return { rows: opts.campaignRow ? [opts.campaignRow] : [] };
    }
    if (sql.includes("FROM optimization_rounds r") && sql.includes("JOIN optimization_campaigns c")) {
      return { rows: opts.ingestCampaignDomain ?? [] };
    }
    if (sql.includes("FROM optimization_campaigns") && sql.includes("WHERE id")) {
      return { rows: opts.campaignSelect ?? [] };
    }
    if (sql.includes("FROM optimization_rounds") && sql.includes("ORDER BY round_index")) {
      return { rows: opts.rounds ?? [] };
    }
    if (sql.includes("FROM optimization_rounds") && sql.includes("id <> ")) {
      return { rows: [] }; // priorOutcomes lookup, default empty
    }
    if (sql.includes("INSERT INTO optimization_rounds")) {
      return { rows: [{ id: opts.insertRoundId ?? "11111111-2222-3333-4444-555555555555" }] };
    }
    if (sql.includes("UPDATE optimization_rounds")) {
      return { rows: opts.ingestRow ? [opts.ingestRow] : [], rowCount: opts.ingestRow ? 1 : 0 };
    }
    if (sql.includes("SELECT ingested_results_at FROM optimization_rounds")) {
      return { rows: opts.ingestExistsRow !== undefined ? [opts.ingestExistsRow] : [] };
    }
    if (sql.includes("UPDATE synthesis_campaign_steps")) {
      return {
        rows: opts.ingestStepUpdate ?? [],
        rowCount: (opts.ingestStepUpdate ?? []).length,
      };
    }
    if (sql.includes("INSERT INTO synthesis_campaign_events")) return { rows: [] };
    if (sql.includes("record_error_event")) return { rows: [] };
    return { rows: [] };
  });
  return {
    connect: vi.fn(async () => ({ query: queryFn, release: vi.fn() })),
    queries,
    queryFn,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("start_optimization_campaign", () => {
  it("builds domain via MCP and inserts campaign row with seed + version + constraints", async () => {
    const pool = makePoolMock({
      resolvedNceProjectId: "00000000-0000-0000-0000-000000000001",
      campaignRow: {
        id: "aaaaaaaa-1111-2222-3333-444444444444",
        campaign_name: "buchwald-1",
        status: "active",
      },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          bofire_domain: { type: "Domain" },
          n_inputs: 2,
          n_outputs: 1,
          n_constraints: 1,
          bofire_version: "0.3.4",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildStartOptimizationCampaignTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), {
      campaign_name: "buchwald-1",
      nce_project_internal_id: "PRJ-1",
      factors: [
        { name: "t", type: "continuous", range: [25, 100] },
        { name: "loading", type: "continuous", range: [1, 10] },
      ],
      categorical_inputs: [{ name: "solvent", values: ["EtOH", "Toluene"] }],
      outputs: [{ name: "yield_pct", direction: "maximize" }],
      constraints: [
        { type: "<=", features: ["t", "loading"], coefficients: [1, 5], rhs: 200 },
      ],
      output_bounds: [{ name: "yield_pct", lo: 0, hi: 100 }],
      campaign_type: "single_objective",
      strategy: "SoboStrategy",
      acquisition: "qLogEI",
    });

    expect(result.campaign_id).toBe("aaaaaaaa-1111-2222-3333-444444444444");
    expect(result.n_inputs).toBe(2);
    expect(result.n_outputs).toBe(1);
    expect(result.n_constraints).toBe(1);
    expect(result.bofire_version).toBe("0.3.4");
    expect(Number.isInteger(result.seed)).toBe(true);
    expect(result.seed).toBeGreaterThanOrEqual(0);
  });

  it("rejects when nce_project_internal_id resolves to no row (RLS-filtered or absent)", async () => {
    const pool = makePoolMock({});
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          bofire_domain: {},
          n_inputs: 1,
          n_outputs: 1,
          n_constraints: 0,
          bofire_version: "0.3.4",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const tool = buildStartOptimizationCampaignTool(pool as never, URL_);
    await expect(
      tool.execute(makeCtx(), {
        campaign_name: "x",
        nce_project_internal_id: "PRJ-IM-NOT-IN",
        factors: [{ name: "t", type: "continuous", range: [0, 1] }],
        categorical_inputs: [],
        outputs: [{ name: "y", direction: "maximize" }],
        constraints: [],
        output_bounds: [],
        campaign_type: "single_objective",
        strategy: "SoboStrategy",
        acquisition: "qLogEI",
      }),
    ).rejects.toThrow(/nce_project_not_found_or_forbidden/);
  });

  it("rejects when supplied synthesis_campaign_id is not visible under RLS", async () => {
    const pool = makePoolMock({
      resolvedNceProjectId: "00000000-0000-0000-0000-000000000001",
      // synthesisCampaignVisibleId omitted → SELECT returns empty
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          bofire_domain: {},
          n_inputs: 1,
          n_outputs: 1,
          n_constraints: 0,
          bofire_version: "0.3.4",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const tool = buildStartOptimizationCampaignTool(pool as never, URL_);
    await expect(
      tool.execute(makeCtx(), {
        campaign_name: "x",
        nce_project_internal_id: "PRJ-1",
        synthesis_campaign_id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        factors: [{ name: "t", type: "continuous", range: [0, 1] }],
        categorical_inputs: [],
        outputs: [{ name: "y", direction: "maximize" }],
        constraints: [],
        output_bounds: [],
        campaign_type: "single_objective",
        strategy: "SoboStrategy",
        acquisition: "qLogEI",
      }),
    ).rejects.toThrow(/synthesis_campaign_not_found_or_forbidden/);
  });

  it("rejects output_bounds with lo > hi", async () => {
    const pool = makePoolMock({});
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          bofire_domain: {},
          n_inputs: 1,
          n_outputs: 1,
          n_constraints: 0,
          bofire_version: "0.3.4",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const tool = buildStartOptimizationCampaignTool(pool as never, URL_);
    await expect(
      tool.execute(makeCtx(), {
        campaign_name: "x",
        nce_project_internal_id: "PRJ-1",
        factors: [{ name: "t", type: "continuous", range: [0, 1] }],
        categorical_inputs: [],
        outputs: [{ name: "y", direction: "maximize" }],
        constraints: [],
        output_bounds: [{ name: "y", lo: 100, hi: 0 }],
        campaign_type: "single_objective",
        strategy: "SoboStrategy",
        acquisition: "qLogEI",
      }),
    ).rejects.toThrow(/output_bounds.*lo .* must be <=/);
  });
});

describe("recommend_next_batch", () => {
  it("happy path with 0 prior rounds → cold-start random, advisory lock taken", async () => {
    const pool = makePoolMock({
      campaignSelect: [
        {
          bofire_domain: { type: "Domain" },
          status: "active",
          strategy: "SoboStrategy",
          acquisition: "qLogEI",
          seed: 1234,
          nce_project_id: "00000000-0000-0000-0000-000000000001",
        },
      ],
      rounds: [],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          proposals: [{ factor_values: { t: 50 }, source: "random_cold_start" }],
          n_observations: 0,
          used_bo: false,
          fallback_reason: "cold_start_n_obs=0<3",
          strategy: "SoboStrategy",
          acquisition: "qLogEI",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildRecommendNextBatchTool(pool as never, URL_, stubConfigRegistry());
    const result = await tool.execute(makeCtx(), {
      campaign_id: "aaaaaaaa-1111-2222-3333-444444444444",
      n_candidates: 1,
    });

    expect(result.round_index).toBe(0);
    expect(result.used_bo).toBe(false);
    expect(result.fallback_reason).toMatch(/cold_start/);
    expect(result.proposals).toHaveLength(1);
    expect(pool.queries.some((s) => s.includes("pg_advisory_xact_lock"))).toBe(true);

    // Confirm strategy + acquisition were forwarded to the MCP request.
    expect(fetchMock.mock.calls).toHaveLength(1);
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.strategy).toBe("SoboStrategy");
    expect(body.acquisition).toBe("qLogEI");
  });

  it("bumps optimization_campaigns.etag after a successful round INSERT", async () => {
    const pool = makePoolMock({
      campaignSelect: [
        {
          bofire_domain: { type: "Domain" },
          status: "active",
          strategy: "SoboStrategy",
          acquisition: "qLogEI",
          seed: 1234,
          nce_project_id: "00000000-0000-0000-0000-000000000001",
        },
      ],
      rounds: [],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          proposals: [{ factor_values: { t: 50 }, source: "random_cold_start" }],
          n_observations: 0,
          used_bo: false,
          fallback_reason: "cold_start_n_obs=0<3",
          strategy: "SoboStrategy",
          acquisition: "qLogEI",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildRecommendNextBatchTool(pool as never, URL_, stubConfigRegistry());
    await tool.execute(makeCtx(), {
      campaign_id: "aaaaaaaa-1111-2222-3333-444444444444",
      n_candidates: 1,
    });

    // The advisory-lock txn must include a campaign-etag bump after the round INSERT.
    // Assert ORDER: the UPDATE comes AFTER the round INSERT so a rollback on
    // the INSERT path leaves etag unchanged.
    const insertIdx = pool.queries.findIndex((s) =>
      s.includes("INSERT INTO optimization_rounds"),
    );
    const etagIdx = pool.queries.findIndex((s) =>
      s.includes("UPDATE optimization_campaigns") && s.includes("etag = etag + 1"),
    );
    expect(insertIdx, "INSERT INTO optimization_rounds expected in queries").toBeGreaterThanOrEqual(0);
    expect(etagIdx, "UPDATE optimization_campaigns SET etag = etag + 1 expected").toBeGreaterThan(insertIdx);
  });

  it("BoFire fallback to random_*_failed records an error_event", async () => {
    const pool = makePoolMock({
      campaignSelect: [
        {
          bofire_domain: {},
          status: "active",
          strategy: "SoboStrategy",
          acquisition: "qLogEI",
          seed: 1,
          nce_project_id: "00000000-0000-0000-0000-000000000001",
        },
      ],
      rounds: [],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          proposals: [
            { factor_values: { t: 50 }, source: "random_strategy_failed" },
          ],
          n_observations: 5,
          used_bo: false,
          fallback_reason: "strategy_map_failed: boom",
          strategy: "SoboStrategy",
          acquisition: "qLogEI",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildRecommendNextBatchTool(pool as never, URL_, stubConfigRegistry());
    const result = await tool.execute(makeCtx(), {
      campaign_id: "aaaaaaaa-1111-2222-3333-444444444444",
      n_candidates: 1,
    });
    expect(result.fallback_reason).toMatch(/strategy_map_failed/);
    expect(pool.queries.some((s) => s.includes("record_error_event"))).toBe(true);
  });

  it("rejects inactive campaign", async () => {
    const pool = makePoolMock({
      campaignSelect: [
        {
          bofire_domain: {},
          status: "completed",
          strategy: "SoboStrategy",
          acquisition: "qLogEI",
          seed: 1,
          nce_project_id: "00000000-0000-0000-0000-000000000001",
        },
      ],
    });
    const tool = buildRecommendNextBatchTool(pool as never, URL_, stubConfigRegistry());
    await expect(
      tool.execute(makeCtx(), {
        campaign_id: "aaaaaaaa-1111-2222-3333-444444444444",
        n_candidates: 1,
      }),
    ).rejects.toThrow(/campaign_not_active/);
  });

  it("rejects unknown campaign", async () => {
    const pool = makePoolMock({ campaignSelect: [] });
    const tool = buildRecommendNextBatchTool(pool as never, URL_, stubConfigRegistry());
    await expect(
      tool.execute(makeCtx(), {
        campaign_id: "aaaaaaaa-1111-2222-3333-444444444444",
        n_candidates: 1,
      }),
    ).rejects.toThrow(/campaign_not_found/);
  });
});

describe("ingest_campaign_results", () => {
  const baseDomain = {
    inputs: {
      features: [
        { key: "t", type: "ContinuousInput" },
        { key: "solvent", type: "CategoricalInput" },
      ],
    },
    outputs: {
      features: [
        { key: "yield_pct", type: "ContinuousOutput", objective: { type: "MaximizeObjective" } },
      ],
    },
  };

  it("happy path: validates keys, ingests, returns improved=true", async () => {
    const pool = makePoolMock({
      ingestCampaignDomain: [
        {
          campaign_id: "aaaaaaaa-1111-2222-3333-444444444444",
          bofire_domain: baseDomain,
          output_bounds: { yield_pct: { lo: 0, hi: 100 } },
          synthesis_campaign_id: null,
        },
      ],
      ingestRow: {
        campaign_id: "aaaaaaaa-1111-2222-3333-444444444444",
        ingested_results_at: "2026-05-03T00:00:00Z",
      },
    });
    const tool = buildIngestCampaignResultsTool(pool as never);
    const result = await tool.execute(makeCtx(), {
      round_id: "11111111-2222-3333-4444-555555555555",
      measured_outcomes: [
        { factor_values: { t: 50, solvent: "EtOH" }, outputs: { yield_pct: 78 } },
      ],
    });
    expect(result.n_outcomes).toBe(1);
    expect(result.improved).toBe(true);
    expect(result.step_backfilled).toBe(false);
  });

  it("rejects unknown factor key", async () => {
    const pool = makePoolMock({
      ingestCampaignDomain: [
        {
          campaign_id: "aaaaaaaa-1111-2222-3333-444444444444",
          bofire_domain: baseDomain,
          output_bounds: {},
          synthesis_campaign_id: null,
        },
      ],
    });
    const tool = buildIngestCampaignResultsTool(pool as never);
    await expect(
      tool.execute(makeCtx(), {
        round_id: "11111111-2222-3333-4444-555555555555",
        measured_outcomes: [
          { factor_values: { temp_c: 50 /* typo */, solvent: "EtOH" }, outputs: { yield_pct: 78 } },
        ],
      }),
    ).rejects.toThrow(/unknown_factor_key/);
  });

  it("rejects unknown output key", async () => {
    const pool = makePoolMock({
      ingestCampaignDomain: [
        {
          campaign_id: "aaaaaaaa-1111-2222-3333-444444444444",
          bofire_domain: baseDomain,
          output_bounds: {},
          synthesis_campaign_id: null,
        },
      ],
    });
    const tool = buildIngestCampaignResultsTool(pool as never);
    await expect(
      tool.execute(makeCtx(), {
        round_id: "11111111-2222-3333-4444-555555555555",
        measured_outcomes: [
          { factor_values: { t: 50, solvent: "EtOH" }, outputs: { wrong_name: 78 } },
        ],
      }),
    ).rejects.toThrow(/unknown_output_key/);
  });

  it("rejects out-of-bounds output value", async () => {
    const pool = makePoolMock({
      ingestCampaignDomain: [
        {
          campaign_id: "aaaaaaaa-1111-2222-3333-444444444444",
          bofire_domain: baseDomain,
          output_bounds: { yield_pct: { lo: 0, hi: 100 } },
          synthesis_campaign_id: null,
        },
      ],
    });
    const tool = buildIngestCampaignResultsTool(pool as never);
    await expect(
      tool.execute(makeCtx(), {
        round_id: "11111111-2222-3333-4444-555555555555",
        measured_outcomes: [
          { factor_values: { t: 50, solvent: "EtOH" }, outputs: { yield_pct: 250 } },
        ],
      }),
    ).rejects.toThrow(/output_out_of_bounds/);
  });

  it("backfills synthesis_campaign_steps when umbrella is linked", async () => {
    const pool = makePoolMock({
      ingestCampaignDomain: [
        {
          campaign_id: "aaaaaaaa-1111-2222-3333-444444444444",
          bofire_domain: baseDomain,
          output_bounds: {},
          synthesis_campaign_id: "ffffffff-1111-2222-3333-444444444444",
        },
      ],
      ingestRow: {
        campaign_id: "aaaaaaaa-1111-2222-3333-444444444444",
        ingested_results_at: "2026-05-03T00:00:00Z",
      },
      ingestStepUpdate: [{ id: "step-1" }],
    });
    const tool = buildIngestCampaignResultsTool(pool as never);
    const result = await tool.execute(makeCtx(), {
      round_id: "11111111-2222-3333-4444-555555555555",
      measured_outcomes: [
        { factor_values: { t: 50, solvent: "EtOH" }, outputs: { yield_pct: 80 } },
        { factor_values: { t: 70, solvent: "EtOH" }, outputs: { yield_pct: 90 } },
      ],
    });
    expect(result.step_backfilled).toBe(true);
    expect(pool.queries.some((s) => s.includes("UPDATE synthesis_campaign_steps"))).toBe(true);
    // The audit-trail event must follow a successful step backfill.
    expect(pool.queries.some((s) => s.includes("INSERT INTO synthesis_campaign_events"))).toBe(true);
  });

  it("rejects missing round (no campaign join row)", async () => {
    const pool = makePoolMock({ ingestCampaignDomain: [] });
    const tool = buildIngestCampaignResultsTool(pool as never);
    await expect(
      tool.execute(makeCtx(), {
        round_id: "11111111-2222-3333-4444-555555555555",
        measured_outcomes: [
          { factor_values: { t: 1, solvent: "EtOH" }, outputs: { yield_pct: 1 } },
        ],
      }),
    ).rejects.toThrow(/round_not_found/);
  });

  it("refuses to overwrite an already-ingested round", async () => {
    const pool = makePoolMock({
      ingestCampaignDomain: [
        {
          campaign_id: "aaaaaaaa-1111-2222-3333-444444444444",
          bofire_domain: baseDomain,
          output_bounds: {},
          synthesis_campaign_id: null,
        },
      ],
      // ingestRow omitted → UPDATE returns no rows → builtin checks existence.
      ingestExistsRow: { ingested_results_at: "2026-05-03T00:00:00Z" },
    });
    const tool = buildIngestCampaignResultsTool(pool as never);
    await expect(
      tool.execute(makeCtx(), {
        round_id: "11111111-2222-3333-4444-555555555555",
        measured_outcomes: [
          { factor_values: { t: 1, solvent: "EtOH" }, outputs: { yield_pct: 1 } },
        ],
      }),
    ).rejects.toThrow(/round_already_ingested/);
  });
});
