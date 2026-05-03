// Tests for buildPredictYieldWithUqTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildPredictYieldWithUqTool } from "../../../src/tools/builtins/predict_yield_with_uq.js";

const URL_ = "http://mcp-yield-baseline:8015";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

function makePoolMock(rows: Array<{ rxn_smiles: string; yield_pct: number }>) {
  return {
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        if (typeof sql === "string" && sql.includes("yield_pct IS NOT NULL")) {
          return { rows };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    })),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("buildPredictYieldWithUqTool", () => {
  it("happy path: project has 60 labels → /train then /predict_yield", async () => {
    const labels = Array.from({ length: 60 }, (_, i) => ({
      rxn_smiles: `CC>>CC${i}`,
      yield_pct: 50 + i,
    }));
    const pool = makePoolMock(labels);

    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({ model_id: "PRJ-001@abc123", n_train: 60, cached_for_seconds: 1800 }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          predictions: [
            {
              rxn_smiles: "O>>P",
              ensemble_mean: 65,
              ensemble_std: 7,
              components: { chemprop_mean: 60, chemprop_std: 5, xgboost_mean: 70 },
              used_global_fallback: false,
              model_id: "PRJ-001@abc123",
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildPredictYieldWithUqTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), {
      rxn_smiles_list: ["O>>P"],
      project_internal_id: "PRJ-001",
    });

    expect(result.predictions).toHaveLength(1);
    expect(result.predictions[0]!.ensemble_mean).toBe(65);
    expect(result.predictions[0]!.used_global_fallback).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const trainBody = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(trainBody.training_pairs).toHaveLength(60);
  });

  it("bootstrap path: project has 5 labels → no /train, used_global_fallback", async () => {
    const labels = Array.from({ length: 5 }, () => ({
      rxn_smiles: "CC>>CC",
      yield_pct: 50,
    }));
    const pool = makePoolMock(labels);

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          predictions: [
            {
              rxn_smiles: "O>>P",
              ensemble_mean: 60,
              ensemble_std: 8,
              components: { chemprop_mean: 60, chemprop_std: 5, xgboost_mean: 60 },
              used_global_fallback: true,
              model_id: null,
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildPredictYieldWithUqTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), {
      rxn_smiles_list: ["O>>P"],
      project_internal_id: "PRJ-EMPTY",
    });

    // Only /predict_yield was called — no /train.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.predictions[0]!.used_global_fallback).toBe(true);
  });

  it("retries once on 412 (cache miss)", async () => {
    const labels = Array.from({ length: 60 }, (_, i) => ({
      rxn_smiles: `CC>>CC${i}`,
      yield_pct: 50 + i,
    }));
    const pool = makePoolMock(labels);

    const fetchMock = vi.fn();
    // 1st: /train
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({ model_id: "PRJ-001@abc", n_train: 60, cached_for_seconds: 1800 }),
    });
    // 2nd: /predict_yield → 412
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 412,
      text: async () => JSON.stringify({ detail: "needs_calibration: ..." }),
    });
    // 3rd: /train (re-supply)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({ model_id: "PRJ-001@abc", n_train: 60, cached_for_seconds: 1800 }),
    });
    // 4th: /predict_yield retry → ok
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          predictions: [
            {
              rxn_smiles: "O>>P",
              ensemble_mean: 65,
              ensemble_std: 7,
              components: { chemprop_mean: 60, chemprop_std: 5, xgboost_mean: 70 },
              used_global_fallback: false,
              model_id: "PRJ-001@abc",
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildPredictYieldWithUqTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), {
      rxn_smiles_list: ["O>>P"],
      project_internal_id: "PRJ-001",
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.predictions[0]!.ensemble_mean).toBe(65);
  });

  it("inputSchema rejects empty rxn_smiles_list", () => {
    const pool = makePoolMock([]);
    const tool = buildPredictYieldWithUqTool(pool as never, URL_);
    expect(tool.inputSchema.safeParse({ rxn_smiles_list: [] }).success).toBe(false);
  });
});
