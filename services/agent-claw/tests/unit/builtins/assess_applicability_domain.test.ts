// Tests for buildAssessApplicabilityDomainTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildAssessApplicabilityDomainTool } from "../../../src/tools/builtins/assess_applicability_domain.js";

const URLS = {
  drfp: "http://mcp-drfp:8002",
  chemprop: "http://mcp-chemprop:8009",
  ad: "http://mcp-applicability-domain:8017",
};

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

function makePoolMock(opts: {
  nearestDistance: number | null;
  calibrationRows: Array<{ rxn_smiles: string; yield_pct: number }>;
  bootstrapRows?: Array<{ rxn_smiles: string; yield_pct: number }>;
}) {
  let yieldQueryCount = 0;
  const auditInserts: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (typeof sql === "string" && sql.includes("drfp_vector <=>")) {
          return {
            rows:
              opts.nearestDistance !== null
                ? [{ distance: opts.nearestDistance }]
                : [],
          };
        }
        if (typeof sql === "string" && sql.includes("yield_pct IS NOT NULL")) {
          yieldQueryCount++;
          // First yield query: project-scoped. Second (if any): cross-project bootstrap.
          if (yieldQueryCount === 1) {
            return { rows: opts.calibrationRows };
          }
          return { rows: opts.bootstrapRows ?? opts.calibrationRows };
        }
        if (typeof sql === "string" && sql.includes("INSERT INTO admin_audit_log")) {
          auditInserts.push({ sql, params: params ?? [] });
          return { rows: [{ id: "00000000-0000-0000-0000-000000000001" }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    })),
  };
  return Object.assign(pool, { auditInserts });
}

const ENCODED_VECTOR = Array.from({ length: 2048 }, () => 0);
const FAKE_DRFP_RESPONSE = { vector: ENCODED_VECTOR, on_bit_count: 0 };

afterEach(() => vi.unstubAllGlobals());

describe("buildAssessApplicabilityDomainTool", () => {
  it("happy path: project has enough calibration → in_domain verdict", async () => {
    const calibrationRows = Array.from({ length: 50 }, (_, i) => ({
      rxn_smiles: `CC>>CC${i}`,
      yield_pct: 50 + i,
    }));
    const pool = makePoolMock({ nearestDistance: 0.3, calibrationRows });

    const fetchMock = vi.fn();
    // 1) drfp /encode
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(FAKE_DRFP_RESPONSE),
    });
    // 2) chemprop /predict_yield
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        predictions: calibrationRows.map((r) => ({
          rxn_smiles: r.rxn_smiles,
          predicted_yield: r.yield_pct + 10,
          std: 1.0,
          model_id: "yield_model@v1",
        })),
      }),
    });
    // 3) ad /calibrate
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        calibration_id: "abcdef0123456789",
        calibration_size: 50,
        cached_for_seconds: 1800,
      }),
    });
    // 4) ad /assess
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        verdict: "in_domain",
        tanimoto_signal: { distance: 0.3, tanimoto: 0.7, threshold_in: 0.5, threshold_out: 0.7, in_band: true },
        mahalanobis_signal: { mahalanobis: 100, threshold_in: 2150, threshold_out: 2200, in_band: true, stats_version: "drfp_stats_v1", n_train: 1 },
        conformal_signal: { alpha: 0.20, half_width: 10, calibration_size: 50, used_global_fallback: false, threshold_in: 30, threshold_out: 50, in_band: true },
        used_global_fallback: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildAssessApplicabilityDomainTool(pool as never, URLS.drfp, URLS.chemprop, URLS.ad);
    const result = await tool.execute(makeCtx(), {
      rxn_smiles: "CC.OO>>CC(=O)O",
      project_internal_id: "PRJ-001",
    });

    expect(result.verdict).toBe("in_domain");
    expect(result.tanimoto_signal.in_band).toBe(true);
    expect(result.conformal_signal?.in_band).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("bootstrap path: project has 0 calibration → falls back to cross-project", async () => {
    const bootstrapRows = Array.from({ length: 40 }, (_, i) => ({
      rxn_smiles: `CC>>CC${i}`,
      yield_pct: 50 + i,
    }));
    const pool = makePoolMock({
      nearestDistance: 0.4,
      calibrationRows: [],
      bootstrapRows,
    });

    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(FAKE_DRFP_RESPONSE) });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        predictions: bootstrapRows.map((r) => ({
          rxn_smiles: r.rxn_smiles,
          predicted_yield: r.yield_pct,
          std: 1.0,
          model_id: "y@v1",
        })),
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        calibration_id: "boot01",
        calibration_size: 40,
        cached_for_seconds: 1800,
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        verdict: "borderline",
        tanimoto_signal: { distance: 0.4, tanimoto: 0.6, threshold_in: 0.5, threshold_out: 0.7, in_band: true },
        mahalanobis_signal: { mahalanobis: 2160, threshold_in: 2150, threshold_out: 2200, in_band: false, stats_version: "v1", n_train: 1 },
        conformal_signal: { alpha: 0.20, half_width: 5, calibration_size: 40, used_global_fallback: true, threshold_in: 30, threshold_out: 50, in_band: true },
        used_global_fallback: true,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildAssessApplicabilityDomainTool(pool as never, URLS.drfp, URLS.chemprop, URLS.ad);
    const result = await tool.execute(makeCtx(), {
      rxn_smiles: "CC>>CC",
      project_internal_id: "PRJ-EMPTY",
    });

    expect(result.used_global_fallback).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Bootstrap audit (kg-transfer-learning.md §7 Q6): the fallback path
    // must write an admin_audit_log row tagged with the originating user
    // and the supplied project id, with no SMILES in the payload.
    expect(pool.auditInserts.length).toBe(1);
    const audit = pool.auditInserts[0]!;
    // Schema: actor, action, target, before, after, reason, request_id, trace_id
    expect(audit.params[0]).toBe("test@example.com");
    expect(audit.params[1]).toBe("ad.cross_project_bootstrap_used");
    expect(audit.params[2]).toBe("PRJ-EMPTY");
    const after = JSON.parse(audit.params[4] as string);
    expect(after.calibration_size).toBe(40);
    expect(after.project_internal_id_supplied).toBe(true);
    // SMILES must not leak into the audit payload.
    const allParams = audit.params.map((p) => (typeof p === "string" ? p : ""));
    for (const p of allParams) {
      expect(p).not.toContain("CC>>CC");
    }
  });

  it("happy path does not write a bootstrap audit row", async () => {
    const calibrationRows = Array.from({ length: 50 }, (_, i) => ({
      rxn_smiles: `CC>>CC${i}`,
      yield_pct: 50 + i,
    }));
    const pool = makePoolMock({ nearestDistance: 0.3, calibrationRows });

    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(FAKE_DRFP_RESPONSE) });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        predictions: calibrationRows.map((r) => ({
          rxn_smiles: r.rxn_smiles,
          predicted_yield: r.yield_pct,
          std: 1.0,
          model_id: "y@v1",
        })),
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        calibration_id: "ok01",
        calibration_size: 50,
        cached_for_seconds: 1800,
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        verdict: "in_domain",
        tanimoto_signal: { distance: 0.3, tanimoto: 0.7, threshold_in: 0.5, threshold_out: 0.7, in_band: true },
        mahalanobis_signal: { mahalanobis: 100, threshold_in: 2150, threshold_out: 2200, in_band: true, stats_version: "v1", n_train: 1 },
        conformal_signal: { alpha: 0.20, half_width: 5, calibration_size: 50, used_global_fallback: false, threshold_in: 30, threshold_out: 50, in_band: true },
        used_global_fallback: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildAssessApplicabilityDomainTool(pool as never, URLS.drfp, URLS.chemprop, URLS.ad);
    await tool.execute(makeCtx(), {
      rxn_smiles: "CC.OO>>CC(=O)O",
      project_internal_id: "PRJ-001",
    });

    // No fallback → no audit row.
    expect(pool.auditInserts.length).toBe(0);
  });

  it("conformal abstain: cross-project total < 30 → empty residuals path", async () => {
    const pool = makePoolMock({
      nearestDistance: 0.5,
      calibrationRows: [],
      bootstrapRows: [{ rxn_smiles: "CC>>CC", yield_pct: 80 }], // only 1 row
    });

    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(FAKE_DRFP_RESPONSE) });
    // No /predict_yield call; no /calibrate call. Direct /assess with empty inline_residuals.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        verdict: "borderline",
        tanimoto_signal: { distance: 0.5, tanimoto: 0.5, threshold_in: 0.5, threshold_out: 0.7, in_band: true },
        mahalanobis_signal: { mahalanobis: 100, threshold_in: 2150, threshold_out: 2200, in_band: true, stats_version: "v1", n_train: 1 },
        conformal_signal: null,
        used_global_fallback: true,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildAssessApplicabilityDomainTool(pool as never, URLS.drfp, URLS.chemprop, URLS.ad);
    const result = await tool.execute(makeCtx(), { rxn_smiles: "CC>>CC" });

    expect(result.conformal_signal).toBeNull();
    expect(result.used_global_fallback).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2); // drfp + assess only
  });

  it("inputSchema requires non-empty rxn_smiles", () => {
    const pool = makePoolMock({ nearestDistance: 0.5, calibrationRows: [] });
    const tool = buildAssessApplicabilityDomainTool(pool as never, URLS.drfp, URLS.chemprop, URLS.ad);
    expect(tool.inputSchema.safeParse({ rxn_smiles: "" }).success).toBe(false);
  });
});
