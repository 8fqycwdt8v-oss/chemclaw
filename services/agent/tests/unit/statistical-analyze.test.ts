import { describe, it, expect, vi } from "vitest";
import {
  StatisticalAnalyzeInput,
  statisticalAnalyze,
} from "../../src/tools/statistical-analyze.js";

function mockPool(rows: any[]) {
  const client = {
    query: vi.fn(async () => ({ rows })),
    release: () => void 0,
  };
  return { connect: vi.fn(async () => client) } as any;
}

const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-0000-0000-00000000000${i + 1}`);

describe("statistical_analyze", () => {
  it("routes predict_yield_for_similar through featurize + predict_and_rank", async () => {
    const rows = ids.map((id) => ({
      reaction_id: id, rxn_smiles: "CC>>CC", rxno_class: null,
      temp_c: 80, time_min: 120, solvent: "thf",
      catalyst_loading_mol_pct: 2, base: "K2CO3", yield_pct: 50,
    }));
    const pool = mockPool(rows);
    const tabicl = {
      featurize: vi.fn(async () => ({
        feature_names: ["temp_c"], categorical_names: [],
        rows: rows.map(() => [80]), targets: rows.map(() => 50), skipped: [],
      })),
      predictAndRank: vi.fn(async () => ({
        predictions: [60], prediction_std: [5], feature_importance: null,
      })),
    };
    const input = StatisticalAnalyzeInput.parse({
      reaction_ids: ids, query_reaction_ids: [ids[0]],
      question: "predict_yield_for_similar",
    });
    const out = await statisticalAnalyze(input, {
      pool, tabicl: tabicl as any, userEntraId: "user-a",
    });
    expect(tabicl.featurize).toHaveBeenCalled();
    expect(tabicl.predictAndRank).toHaveBeenCalled();
    expect(out.predictions).toEqual([{ query_reaction_id: ids[0], predicted_yield_pct: 60, std: 5 }]);
  });

  it("routes compare_conditions through SQL only (no ML call)", async () => {
    const pool = mockPool([
      { bucket_label: "thf·80-100", n: 4, mean_yield: 70, median_yield: 72, p25: 60, p75: 80 },
    ]);
    const tabicl = { featurize: vi.fn(), predictAndRank: vi.fn() };
    const input = StatisticalAnalyzeInput.parse({
      reaction_ids: ids, question: "compare_conditions",
    });
    const out = await statisticalAnalyze(input, {
      pool, tabicl: tabicl as any, userEntraId: "user-a",
    });
    expect(tabicl.featurize).not.toHaveBeenCalled();
    expect(tabicl.predictAndRank).not.toHaveBeenCalled();
    expect(out.condition_comparison?.length).toBeGreaterThan(0);
  });

  it("surfaces featurizer skipped rows as caveats", async () => {
    const rows = ids.map((id) => ({
      reaction_id: id, rxn_smiles: "CC>>CC", rxno_class: null,
      temp_c: null, time_min: null, solvent: null,
      catalyst_loading_mol_pct: null, base: null, yield_pct: 50,
    }));
    const pool = mockPool(rows);
    const tabicl = {
      featurize: vi.fn(async () => ({
        feature_names: ["temp_c"], categorical_names: [],
        rows: [[80]], targets: [50],
        skipped: [{ reaction_id: ids[1], reason: "invalid_rxn_smiles" }],
      })),
      predictAndRank: vi.fn(async () => ({
        predictions: [50], prediction_std: [0], feature_importance: { temp_c: 0.1 },
      })),
    };
    const input = StatisticalAnalyzeInput.parse({
      reaction_ids: ids, question: "rank_feature_importance",
    });
    const out = await statisticalAnalyze(input, {
      pool, tabicl: tabicl as any, userEntraId: "user-a",
    });
    expect(out.caveats.join(" ")).toMatch(/skipped/i);
    expect(out.feature_importance?.[0].feature).toBe("temp_c");
  });
});
