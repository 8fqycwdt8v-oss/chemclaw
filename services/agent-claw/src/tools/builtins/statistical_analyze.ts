// statistical_analyze — Phase B.2 builtin.
//
// Three question modes:
//   predict_yield_for_similar  — TabICL regression on support + query reactions
//   rank_feature_importance    — TabICL permutation importance
//   compare_conditions         — pure SQL bucket aggregation (no ML)
//
// All DB reads are RLS-scoped.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";

// ---------- Schemas ----------------------------------------------------------

export const StatisticalAnalyzeIn = z.object({
  reaction_ids: z.array(z.string().uuid()).min(5).max(500),
  question: z.enum([
    "predict_yield_for_similar",
    "rank_feature_importance",
    "compare_conditions",
  ]),
  query_reaction_ids: z.array(z.string().uuid()).max(100).optional(),
});
export type StatisticalAnalyzeInput = z.infer<typeof StatisticalAnalyzeIn>;

export const StatisticalAnalyzeOut = z.object({
  task: z.literal("regression"),
  support_size: z.number().int().nonnegative(),
  predictions: z
    .array(
      z.object({
        query_reaction_id: z.string().uuid(),
        predicted_yield_pct: z.number(),
        std: z.number(),
      }),
    )
    .optional(),
  feature_importance: z
    .array(
      z.object({
        feature: z.string(),
        importance: z.number(),
      }),
    )
    .optional(),
  condition_comparison: z
    .array(
      z.object({
        bucket_label: z.string(),
        n: z.number().int(),
        mean_yield: z.number(),
        median_yield: z.number(),
        p25: z.number(),
        p75: z.number(),
      }),
    )
    .optional(),
  caveats: z.array(z.string()),
});
export type StatisticalAnalyzeOutput = z.infer<typeof StatisticalAnalyzeOut>;

// mcp-tabicl featurize response schema (partial — only the fields we use).
const TabiclFeaturizeOut = z.object({
  rows: z.array(z.array(z.number())),
  targets: z.array(z.number()).optional(),
  feature_names: z.array(z.string()),
  categorical_names: z.array(z.string()),
  skipped: z.array(z.string()),
});

const TabiclPredictOut = z.object({
  predictions: z.array(z.number()),
  prediction_std: z.array(z.number()),
  feature_importance: z.record(z.number()).optional(),
});

// ---------- Timeout ----------------------------------------------------------

const TIMEOUT_TABICL_MS = 60_000;

// ---------- DB helpers -------------------------------------------------------

interface ReactionRow {
  reaction_id: string;
  rxn_smiles: string | null;
  rxno_class: string | null;
  temp_c: string | null;
  time_min: string | null;
  solvent: string | null;
  catalyst_loading_mol_pct: string | null;
  base: string | null;
  yield_pct: string | null;
}

async function loadReactionRows(
  pool: Pool,
  userEntraId: string,
  ids: string[],
): Promise<ReactionRow[]> {
  return withUserContext(pool, userEntraId, async (client) => {
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
    return q.rows as ReactionRow[];
  });
}

function toTabiclRow(r: ReactionRow, includeTarget: boolean) {
  return {
    reaction_id: r.reaction_id,
    rxn_smiles: r.rxn_smiles,
    rxno_class: r.rxno_class ?? null,
    solvent: r.solvent ?? null,
    temp_c: r.temp_c != null ? Number(r.temp_c) : null,
    time_min: r.time_min != null ? Number(r.time_min) : null,
    catalyst_loading_mol_pct:
      r.catalyst_loading_mol_pct != null ? Number(r.catalyst_loading_mol_pct) : null,
    base: r.base ?? null,
    yield_pct: includeTarget && r.yield_pct != null ? Number(r.yield_pct) : null,
  };
}

// ---------- Factory ----------------------------------------------------------

export function buildStatisticalAnalyzeTool(pool: Pool, mcpTabiclUrl: string) {
  const base = mcpTabiclUrl.replace(/\/$/, "");

  return defineTool({
    id: "statistical_analyze",
    description:
      "Run statistical analysis on a set of reactions. " +
      "question=compare_conditions: SQL bucket aggregation of yield by solvent/temperature (no ML). " +
      "question=predict_yield_for_similar: TabICL regression — predict yield for query_reaction_ids. " +
      "question=rank_feature_importance: TabICL permutation importance ranking.",
    inputSchema: StatisticalAnalyzeIn,
    outputSchema: StatisticalAnalyzeOut,

    execute: async (ctx, input) => {
      const caveats: string[] = [];

      // ── compare_conditions: pure SQL, no ML ────────────────────────────────
      if (input.question === "compare_conditions") {
        const rows = await withUserContext(pool, ctx.userEntraId, async (client) => {
          const q = await client.query(
            `SELECT CONCAT(COALESCE(e.solvent,'?'), '·',
                          width_bucket(COALESCE(e.temperature_c,0), 0, 200, 10)::text) AS bucket_label,
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
            [input.reaction_ids],
          );
          return q.rows;
        });
        return StatisticalAnalyzeOut.parse({
          task: "regression",
          support_size: input.reaction_ids.length,
          condition_comparison: rows.map((r: Record<string, unknown>) => ({
            bucket_label: r.bucket_label as string,
            n: r.n as number,
            mean_yield: Number(r.mean_yield),
            median_yield: Number(r.median_yield),
            p25: Number(r.p25),
            p75: Number(r.p75),
          })),
          caveats,
        });
      }

      // ── Featurize support rows ─────────────────────────────────────────────
      const supportDbRows = await loadReactionRows(pool, ctx.userEntraId, input.reaction_ids);
      const featurized = await postJson(
        `${base}/tools/featurize`,
        {
          reaction_rows: supportDbRows.map((r) => toTabiclRow(r, true)),
          include_targets: true,
        },
        TabiclFeaturizeOut,
        TIMEOUT_TABICL_MS,
        "mcp-tabicl",
      );

      if (featurized.skipped.length > 0) {
        caveats.push(
          `${featurized.skipped.length} rows skipped by featurizer (invalid SMILES or missing target).`,
        );
      }
      if (!featurized.targets || featurized.targets.length === 0) {
        return StatisticalAnalyzeOut.parse({
          task: "regression",
          support_size: 0,
          caveats: [...caveats, "no usable support rows"],
        });
      }

      // ── predict_yield_for_similar ─────────────────────────────────────────
      if (input.question === "predict_yield_for_similar") {
        if (!input.query_reaction_ids || input.query_reaction_ids.length === 0) {
          throw new Error("query_reaction_ids required for predict_yield_for_similar");
        }
        const queryDbRows = await loadReactionRows(
          pool,
          ctx.userEntraId,
          input.query_reaction_ids,
        );
        const queryFeat = await postJson(
          `${base}/tools/featurize`,
          {
            reaction_rows: queryDbRows.map((r) => toTabiclRow(r, false)),
            include_targets: false,
          },
          TabiclFeaturizeOut,
          TIMEOUT_TABICL_MS,
          "mcp-tabicl",
        );
        const pred = await postJson(
          `${base}/tools/predict_and_rank`,
          {
            support_rows: featurized.rows,
            support_targets: featurized.targets,
            query_rows: queryFeat.rows,
            feature_names: featurized.feature_names,
            categorical_names: featurized.categorical_names,
            task: "regression",
            return_feature_importance: false,
          },
          TabiclPredictOut,
          TIMEOUT_TABICL_MS,
          "mcp-tabicl",
        );
        return StatisticalAnalyzeOut.parse({
          task: "regression",
          support_size: featurized.rows.length,
          predictions: pred.predictions.map((p, i) => ({
            query_reaction_id: input.query_reaction_ids![i]!,
            predicted_yield_pct: p,
            std: pred.prediction_std[i] ?? 0,
          })),
          caveats,
        });
      }

      // ── rank_feature_importance ───────────────────────────────────────────
      const pred = await postJson(
        `${base}/tools/predict_and_rank`,
        {
          support_rows: featurized.rows,
          support_targets: featurized.targets,
          query_rows: featurized.rows.slice(0, Math.min(16, featurized.rows.length)),
          feature_names: featurized.feature_names,
          categorical_names: featurized.categorical_names,
          task: "regression",
          return_feature_importance: true,
        },
        TabiclPredictOut,
        TIMEOUT_TABICL_MS,
        "mcp-tabicl",
      );
      const fi = pred.feature_importance ?? {};
      return StatisticalAnalyzeOut.parse({
        task: "regression",
        support_size: featurized.rows.length,
        feature_importance: Object.entries(fi)
          .sort(([, a], [, b]) => b - a)
          .map(([feature, importance]) => ({ feature, importance })),
        caveats,
      });
    },
  });
}
