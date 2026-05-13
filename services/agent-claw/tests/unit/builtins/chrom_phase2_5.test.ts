// Tests for the Phase Z6 chromatography Phases 2-5 builtins:
// ingest_chrom_results, extract_chrom_pareto_front, simulate_chrom_retention.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildIngestChromResultsTool } from "../../../src/tools/builtins/ingest_chrom_results.js";
import { buildExtractChromParetoFrontTool } from "../../../src/tools/builtins/extract_chrom_pareto_front.js";
import { buildSimulateChromRetentionTool } from "../../../src/tools/builtins/simulate_chrom_retention.js";

const URL_ = "http://mcp-chrom-method-optimizer:8019";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

interface PoolOpts {
  roundLookup?: { campaign_id: string; proposals: unknown; ingested_results_at: string | null }[];
  updateRoundRow?: { campaign_id: string; ingested_results_at: string } | null;
  campaignRow?: { id: string }[];
  rounds?: { measured_outcomes: unknown }[];
}

function makePoolMock(opts: PoolOpts) {
  const queries: { sql: string; params: unknown[] | undefined }[] = [];
  const queryFn = vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes("SELECT campaign_id::text, proposals, ingested_results_at")) {
      return { rows: opts.roundLookup ?? [] };
    }
    if (sql.includes("UPDATE optimization_rounds")) {
      return { rows: opts.updateRoundRow ? [opts.updateRoundRow] : [] };
    }
    if (sql.includes("FROM optimization_campaigns WHERE id")) {
      return { rows: opts.campaignRow ?? [] };
    }
    if (sql.includes("SELECT measured_outcomes FROM optimization_rounds WHERE campaign_id")) {
      return { rows: opts.rounds ?? [] };
    }
    return { rows: [] };
  });
  return { connect: vi.fn(async () => ({ query: queryFn, release: vi.fn() })), queries };
}

afterEach(() => vi.unstubAllGlobals());


describe("ingest_chrom_results", () => {
  it("scores each run via the MCP and writes measured_outcomes", async () => {
    const pool = makePoolMock({
      roundLookup: [{
        campaign_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        ingested_results_at: null,
        proposals: [
          { factor_values: { pctB_init: 5, column: "C18" }, source: "qLogEI" },
          { factor_values: { pctB_init: 10, column: "PFP" }, source: "qLogEI" },
        ],
      }],
      updateRoundRow: { campaign_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", ingested_results_at: "2026-05-13T00:00:00Z" },
    });
    // Two /score_chromatogram calls, one per run.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          crf_total: 1.8, min_resolution: 2.1, n_resolved_pairs: 3, n_peaks: 4,
          runtime_min: 7.5, solvent_pmi_g: 2.4, resolutions: [2.1, 3.0, 4.0],
          resolution_target_met: true, tracking_confidence: "high", unmatched_targets: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          crf_total: 0.9, min_resolution: 0.4, n_resolved_pairs: 1, n_peaks: 4,
          runtime_min: 9.0, solvent_pmi_g: 2.8, resolutions: [0.4, 2.0],
          resolution_target_met: false, tracking_confidence: "partial", unmatched_targets: ["Imp B"],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildIngestChromResultsTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), {
      round_id: "11111111-2222-3333-4444-555555555555",
      runs: [
        { proposal_index: 0, peaks: [{ rt_min: 2.0, fwhm_min: 0.04 }], targets: [], runtime_min: 7.5, b_solvent: "MeCN", flow_mLmin: 0.4, avg_pctB: 50 },
        { proposal_index: 1, peaks: [{ rt_min: 3.0, name: "API" }], targets: [{ name: "API" }, { name: "Imp B", m_z: 333.1 }] },
      ],
      rs_target: 1.5,
      runtime_target_min: 8.0,
    });

    expect(result.n_outcomes).toBe(2);
    expect(result.scored).toHaveLength(2);
    expect(result.scored[0]!.crf_total).toBe(1.8);
    expect(result.scored[1]!.tracking_confidence).toBe("partial");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // measured_outcomes written with factor_values from the proposals.
    const upd = pool.queries.find((q) => q.sql.includes("UPDATE optimization_rounds"));
    expect(upd).toBeDefined();
    const written = JSON.parse((upd!.params as unknown[])[1] as string);
    expect(written).toHaveLength(2);
    expect(written[0].factor_values).toEqual({ pctB_init: 5, column: "C18" });
    expect(written[0].outputs).toMatchObject({ crf_total: 1.8, min_resolution: 2.1, runtime_min: 7.5, solvent_pmi_g: 2.4 });
  });

  it("rejects an already-ingested round", async () => {
    const pool = makePoolMock({
      roundLookup: [{ campaign_id: "x", ingested_results_at: "2026-05-13T00:00:00Z", proposals: [] }],
    });
    const tool = buildIngestChromResultsTool(pool as never, URL_);
    await expect(tool.execute(makeCtx(), {
      round_id: "11111111-2222-3333-4444-555555555555",
      runs: [{ proposal_index: 0, peaks: [], targets: [] }],
      rs_target: 1.5, runtime_target_min: 8.0,
    })).rejects.toThrow(/round_already_ingested/);
  });

  it("rejects out-of-range proposal_index", async () => {
    const pool = makePoolMock({
      roundLookup: [{ campaign_id: "x", ingested_results_at: null, proposals: [{ factor_values: {} }] }],
    });
    vi.stubGlobal("fetch", vi.fn());
    const tool = buildIngestChromResultsTool(pool as never, URL_);
    await expect(tool.execute(makeCtx(), {
      round_id: "11111111-2222-3333-4444-555555555555",
      runs: [{ proposal_index: 5, peaks: [], targets: [] }],
      rs_target: 1.5, runtime_target_min: 8.0,
    })).rejects.toThrow(/proposal_index_out_of_range/);
  });

  it("rejects when the round is not visible (RLS-filtered)", async () => {
    const pool = makePoolMock({ roundLookup: [] });
    const tool = buildIngestChromResultsTool(pool as never, URL_);
    await expect(tool.execute(makeCtx(), {
      round_id: "11111111-2222-3333-4444-555555555555",
      runs: [{ proposal_index: 0, peaks: [], targets: [] }],
      rs_target: 1.5, runtime_target_min: 8.0,
    })).rejects.toThrow(/round_not_found/);
  });
});


describe("extract_chrom_pareto_front", () => {
  it("flattens measured outcomes and returns the Pareto front from the MCP", async () => {
    const measured = [
      { factor_values: { a: 1 }, outputs: { min_resolution: 2.0, runtime_min: 10.0, solvent_pmi_g: 3.0 } },
      { factor_values: { a: 2 }, outputs: { min_resolution: 2.5, runtime_min: 8.0,  solvent_pmi_g: 2.5 } },
    ];
    const pool = makePoolMock({
      campaignRow: [{ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }],
      rounds: [{ measured_outcomes: measured }],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        pareto: [measured[1]],
        n_total: 2, n_pareto: 1,
        output_directions: { min_resolution: "maximize", runtime_min: "minimize", solvent_pmi_g: "minimize" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildExtractChromParetoFrontTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), { campaign_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
    expect(result.n_total).toBe(2);
    expect(result.n_pareto).toBe(1);
    expect(result.pareto[0]!.factor_values).toEqual({ a: 2 });
    // The MCP call carried both measured outcomes.
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.measured_outcomes).toHaveLength(2);
  });

  it("returns an empty front (no MCP call) when the campaign has no measured outcomes", async () => {
    const pool = makePoolMock({
      campaignRow: [{ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }],
      rounds: [{ measured_outcomes: null }],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = buildExtractChromParetoFrontTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), { campaign_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
    expect(result.n_pareto).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when the campaign is not visible (RLS-filtered)", async () => {
    const pool = makePoolMock({ campaignRow: [] });
    const tool = buildExtractChromParetoFrontTool(pool as never, URL_);
    await expect(tool.execute(makeCtx(), { campaign_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }))
      .rejects.toThrow(/campaign_not_found/);
  });
});


describe("simulate_chrom_retention", () => {
  it("forwards to the MCP and returns the simulated chromatogram + score", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        peaks: [
          { name: "A", rt_min: 3.2, width_baseline_min: 0.05 },
          { name: "B", rt_min: 4.1, width_baseline_min: 0.06 },
        ],
        lss_by_analyte: { A: [2.0, 4.0], B: [2.2, 4.0] },
        crf_total: 1.6, min_resolution: 1.9, runtime_min: 4.1, solvent_pmi_g: 0.0,
        n_eluted: 2, n_analytes: 2,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildSimulateChromRetentionTool(URL_);
    const result = await tool.execute(makeCtx(), {
      scouting_observations: { A: [[0.2, 5.0], [0.4, 2.0]], B: [[0.2, 6.0], [0.4, 2.2]] },
      gradient_program: [{ time_min: 0, pctB: 5 }, { time_min: 12, pctB: 95 }, { time_min: 14, pctB: 95 }],
      t0_min: 1.0,
      t_dwell_min: 0,
      plate_count: 10000,
      rs_target: 1.5,
      runtime_target_min: 14.0,
    });
    expect(result.n_eluted).toBe(2);
    expect(result.min_resolution).toBe(1.9);
    expect(result.peaks).toHaveLength(2);
    // Both lss_by_analyte and scouting_observations forwarded (one of them null).
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.scouting_observations).toBeTruthy();
    expect(body.lss_by_analyte).toBeNull();
  });

  it("rejects input with neither lss_by_analyte nor scouting_observations", async () => {
    const tool = buildSimulateChromRetentionTool(URL_);
    await expect(tool.execute(makeCtx(), {
      gradient_program: [{ time_min: 0, pctB: 5 }, { time_min: 5, pctB: 95 }],
      t0_min: 1.0,
    })).rejects.toThrow();
  });
});
