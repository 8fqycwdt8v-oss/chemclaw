// Tool: statistical_analyze — TabICL on a retrieved reaction set.
//
// Three question modes:
//   - predict_yield_for_similar: featurize support + query → predict
//   - rank_feature_importance:   featurize + permutation importance
//   - compare_conditions:        pure SQL bucket aggregation, no ML

import { z } from "zod";
import type { Pool } from "pg";

import type { McpTabiclClient } from "../mcp-clients.js";
import { withUserContext } from "../db.js";

export const StatisticalAnalyzeInput = z.object({
  reaction_ids: z.array(z.string().uuid()).min(5).max(500),
  question: z.enum([
    "predict_yield_for_similar",
    "rank_feature_importance",
    "compare_conditions",
  ]),
  query_reaction_ids: z.array(z.string().uuid()).max(100).optional(),
});
export type StatisticalAnalyzeInput = z.infer<typeof StatisticalAnalyzeInput>;

export const StatisticalAnalyzeOutput = z.object({
  task: z.literal("regression"),
  support_size: z.number().int().nonnegative(),
  predictions: z.array(z.object({
    query_reaction_id: z.string().uuid(),
    predicted_yield_pct: z.number(),
    std: z.number(),
  })).optional(),
  feature_importance: z.array(z.object({
    feature: z.string(),
    importance: z.number(),
  })).optional(),
  condition_comparison: z.array(z.object({
    bucket_label: z.string(),
    n: z.number().int(),
    mean_yield: z.number(),
    median_yield: z.number(),
    p25: z.number(),
    p75: z.number(),
  })).optional(),
  caveats: z.array(z.string()),
});
export type StatisticalAnalyzeOutput = z.infer<typeof StatisticalAnalyzeOutput>;

export interface StatisticalAnalyzeDeps {
  pool: Pool;
  tabicl: McpTabiclClient;
  userEntraId: string;
}

async function loadReactionRows(
  deps: StatisticalAnalyzeDeps,
  ids: string[],
): Promise<any[]> {
  return withUserContext(deps.pool, deps.userEntraId, async (client) => {
    const q = await client.query(
      `SELECT r.id::text               AS reaction_id,
              r.rxn_smiles, r.rxno_class,
              e.temperature_c          AS temp_c,
              e.time_min, e.solvent,
              (e.conditions_json->>'catalyst_loading_mol_pct')::numeric AS catalyst_loading_mol_pct,
              e.base, e.yield_pct
         FROM reactions r
         JOIN experiments e ON e.id = r.experiment_id
        WHERE r.id = ANY($1::uuid[])`,
      [ids],
    );
    return q.rows;
  });
}

export async function statisticalAnalyze(
  input: StatisticalAnalyzeInput,
  deps: StatisticalAnalyzeDeps,
): Promise<StatisticalAnalyzeOutput> {
  const parsed = StatisticalAnalyzeInput.parse(input);
  const caveats: string[] = [];

  if (parsed.question === "compare_conditions") {
    const rows = await withUserContext(deps.pool, deps.userEntraId, async (client) => {
      const q = await client.query(
        `SELECT CONCAT(COALESCE(e.solvent,'?'), '·', width_bucket(COALESCE(e.temperature_c,0), 0, 200, 10)::text) AS bucket_label,
                COUNT(*)::int AS n,
                AVG(e.yield_pct)::float8 AS mean_yield,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY e.yield_pct)::float8 AS median_yield,
                percentile_cont(0.25) WITHIN GROUP (ORDER BY e.yield_pct)::float8 AS p25,
                percentile_cont(0.75) WITHIN GROUP (ORDER BY e.yield_pct)::float8 AS p75
           FROM reactions r
           JOIN experiments e ON e.id = r.experiment_id
          WHERE r.id = ANY($1::uuid[])
            AND e.yield_pct IS NOT NULL
          GROUP BY bucket_label
          ORDER BY mean_yield DESC`,
        [parsed.reaction_ids],
      );
      return q.rows;
    });
    return StatisticalAnalyzeOutput.parse({
      task: "regression",
      support_size: parsed.reaction_ids.length,
      condition_comparison: rows.map((r: any) => ({
        bucket_label: r.bucket_label, n: r.n,
        mean_yield: Number(r.mean_yield), median_yield: Number(r.median_yield),
        p25: Number(r.p25), p75: Number(r.p75),
      })),
      caveats,
    });
  }

  // Featurize support.
  const supportDbRows = await loadReactionRows(deps, parsed.reaction_ids);
  const featurized = await deps.tabicl.featurize({
    reaction_rows: supportDbRows.map((r) => ({
      reaction_id: r.reaction_id,
      rxn_smiles: r.rxn_smiles,
      rxno_class: r.rxno_class ?? null,
      solvent: r.solvent ?? null,
      temp_c: r.temp_c != null ? Number(r.temp_c) : null,
      time_min: r.time_min != null ? Number(r.time_min) : null,
      catalyst_loading_mol_pct: r.catalyst_loading_mol_pct != null ? Number(r.catalyst_loading_mol_pct) : null,
      base: r.base ?? null,
      yield_pct: r.yield_pct != null ? Number(r.yield_pct) : null,
    })),
    include_targets: true,
  });
  if (featurized.skipped.length > 0) {
    caveats.push(`${featurized.skipped.length} rows skipped by featurizer (invalid SMILES or missing target).`);
  }
  if (!featurized.targets || featurized.targets.length === 0) {
    return StatisticalAnalyzeOutput.parse({
      task: "regression", support_size: 0, caveats: [...caveats, "no usable support rows"],
    });
  }

  if (parsed.question === "predict_yield_for_similar") {
    if (!parsed.query_reaction_ids || parsed.query_reaction_ids.length === 0) {
      throw new Error("query_reaction_ids required for predict_yield_for_similar");
    }
    const queryDbRows = await loadReactionRows(deps, parsed.query_reaction_ids);
    const queryFeat = await deps.tabicl.featurize({
      reaction_rows: queryDbRows.map((r) => ({
        reaction_id: r.reaction_id, rxn_smiles: r.rxn_smiles,
        rxno_class: r.rxno_class ?? null, solvent: r.solvent ?? null,
        temp_c: r.temp_c != null ? Number(r.temp_c) : null,
        time_min: r.time_min != null ? Number(r.time_min) : null,
        catalyst_loading_mol_pct: r.catalyst_loading_mol_pct != null ? Number(r.catalyst_loading_mol_pct) : null,
        base: r.base ?? null, yield_pct: null,
      })),
      include_targets: false,
    });
    const pred = await deps.tabicl.predictAndRank({
      support_rows: featurized.rows,
      support_targets: featurized.targets,
      query_rows: queryFeat.rows,
      feature_names: featurized.feature_names,
      categorical_names: featurized.categorical_names,
      task: "regression",
      return_feature_importance: false,
    });
    return StatisticalAnalyzeOutput.parse({
      task: "regression",
      support_size: featurized.rows.length,
      predictions: pred.predictions.map((p, i) => ({
        query_reaction_id: parsed.query_reaction_ids![i],
        predicted_yield_pct: p,
        std: pred.prediction_std[i] ?? 0,
      })),
      caveats,
    });
  }

  // rank_feature_importance
  const pred = await deps.tabicl.predictAndRank({
    support_rows: featurized.rows,
    support_targets: featurized.targets,
    query_rows: featurized.rows.slice(0, Math.min(16, featurized.rows.length)),
    feature_names: featurized.feature_names,
    categorical_names: featurized.categorical_names,
    task: "regression",
    return_feature_importance: true,
  });
  const fi = pred.feature_importance ?? {};
  return StatisticalAnalyzeOutput.parse({
    task: "regression",
    support_size: featurized.rows.length,
    feature_importance: Object.entries(fi)
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .map(([feature, importance]) => ({ feature, importance: importance as number })),
    caveats,
  });
}
