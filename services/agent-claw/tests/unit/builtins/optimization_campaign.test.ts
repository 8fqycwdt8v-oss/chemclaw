// Tests for Z5 closed-loop optimization builtins.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildStartOptimizationCampaignTool } from "../../../src/tools/builtins/start_optimization_campaign.js";
import { buildRecommendNextBatchTool } from "../../../src/tools/builtins/recommend_next_batch.js";
import { buildIngestCampaignResultsTool } from "../../../src/tools/builtins/ingest_campaign_results.js";

const URL_ = "http://mcp-reaction-optimizer:8018";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

function makePoolMock(opts: {
  buildDomainResponse?: unknown;
  campaignRow?: { id: string; campaign_name: string; status: string } | null;
  campaignSelect?: { bofire_domain: unknown; status: string }[];
  rounds?: { measured_outcomes: unknown; round_index: number }[];
  insertRoundId?: string;
  ingestRow?: { campaign_id: string; ingested_results_at: string };
}) {
  const queries: string[] = [];
  const queryFn = vi.fn(async (sql: string, _params?: unknown[]) => {
    queries.push(sql);
    if (sql.includes("nce_projects WHERE internal_id")) {
      return { rows: [] };
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
    if (sql.includes("UPDATE optimization_rounds")) {
      return { rows: opts.ingestRow ? [opts.ingestRow] : [] };
    }
    return { rows: [] };
  });
  return {
    connect: vi.fn(async () => ({ query: queryFn, release: vi.fn() })),
    queries,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("start_optimization_campaign", () => {
  it("builds domain via MCP and inserts campaign row", async () => {
    const pool = makePoolMock({
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
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildStartOptimizationCampaignTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), {
      campaign_name: "buchwald-1",
      factors: [{ name: "t", type: "continuous", range: [25, 100] }],
      categorical_inputs: [{ name: "solvent", values: ["EtOH", "Toluene"] }],
      outputs: [{ name: "yield_pct", direction: "maximize" }],
      campaign_type: "single_objective",
      strategy: "SoboStrategy",
      acquisition: "qLogEI",
    });

    expect(result.campaign_id).toBe("aaaaaaaa-1111-2222-3333-444444444444");
    expect(result.n_inputs).toBe(2);
    expect(result.n_outputs).toBe(1);
  });
});

describe("recommend_next_batch", () => {
  it("happy path with 0 prior rounds → cold-start random", async () => {
    const pool = makePoolMock({
      campaignSelect: [{ bofire_domain: { type: "Domain" }, status: "active" }],
      rounds: [],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          proposals: [{ factor_values: { t: 50 }, source: "random_cold_start" }],
          n_observations: 0,
          used_bo: false,
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildRecommendNextBatchTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), {
      campaign_id: "aaaaaaaa-1111-2222-3333-444444444444",
      n_candidates: 1,
      seed: 42,
    });

    expect(result.round_index).toBe(0);
    expect(result.used_bo).toBe(false);
    expect(result.proposals).toHaveLength(1);
  });

  it("rejects inactive campaign", async () => {
    const pool = makePoolMock({
      campaignSelect: [{ bofire_domain: {}, status: "completed" }],
    });
    const tool = buildRecommendNextBatchTool(pool as never, URL_);
    await expect(
      tool.execute(makeCtx(), {
        campaign_id: "aaaaaaaa-1111-2222-3333-444444444444",
        n_candidates: 1,
        seed: 42,
      }),
    ).rejects.toThrow(/campaign_not_active/);
  });

  it("rejects unknown campaign", async () => {
    const pool = makePoolMock({ campaignSelect: [] });
    const tool = buildRecommendNextBatchTool(pool as never, URL_);
    await expect(
      tool.execute(makeCtx(), {
        campaign_id: "aaaaaaaa-1111-2222-3333-444444444444",
        n_candidates: 1,
        seed: 42,
      }),
    ).rejects.toThrow(/campaign_not_found/);
  });
});

describe("ingest_campaign_results", () => {
  it("happy path", async () => {
    const pool = makePoolMock({
      ingestRow: {
        campaign_id: "aaaaaaaa-1111-2222-3333-444444444444",
        ingested_results_at: "2026-05-03T00:00:00Z",
      },
    });
    const tool = buildIngestCampaignResultsTool(pool as never);
    const result = await tool.execute(makeCtx(), {
      round_id: "11111111-2222-3333-4444-555555555555",
      measured_outcomes: [
        {
          factor_values: { t: 50, solvent: "EtOH" },
          outputs: { yield_pct: 78 },
        },
      ],
    });
    expect(result.n_outcomes).toBe(1);
    expect(result.campaign_id).toBe("aaaaaaaa-1111-2222-3333-444444444444");
  });

  it("rejects missing round", async () => {
    const pool = makePoolMock({});
    const tool = buildIngestCampaignResultsTool(pool as never);
    await expect(
      tool.execute(makeCtx(), {
        round_id: "11111111-2222-3333-4444-555555555555",
        measured_outcomes: [{ factor_values: {}, outputs: { y: 1 } }],
      }),
    ).rejects.toThrow(/round_not_found/);
  });
});
