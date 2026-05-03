// predict_yield_with_uq — chemprop + per-project XGBoost ensemble (Z3).
//
// Pulls per-project labeled training data via the existing withUserContext
// RLS pattern, calls /train (cached server-side), then /predict_yield. Cache
// miss on /predict_yield re-supplies once.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";
import { MAX_RXN_SMILES_LEN, MAX_BATCH_SMILES } from "../_limits.js";

const MIN_TRAIN_PAIRS = 50;
const MAX_TRAIN_PAIRS = 10_000;

// ---------- Schemas ---------------------------------------------------------

export const PredictYieldWithUqIn = z.object({
  rxn_smiles_list: z
    .array(z.string().min(1).max(MAX_RXN_SMILES_LEN))
    .min(1)
    .max(MAX_BATCH_SMILES),
  project_internal_id: z.string().max(200).optional(),
});
export type PredictYieldWithUqInput = z.infer<typeof PredictYieldWithUqIn>;

const ReactionPrediction = z.object({
  rxn_smiles: z.string(),
  ensemble_mean: z.number(),
  ensemble_std: z.number(),
  components: z.object({
    chemprop_mean: z.number(),
    chemprop_std: z.number(),
    xgboost_mean: z.number(),
  }),
  used_global_fallback: z.boolean(),
  model_id: z.string().nullable(),
});

export const PredictYieldWithUqOut = z.object({
  predictions: z.array(ReactionPrediction),
});
export type PredictYieldWithUqOutput = z.infer<typeof PredictYieldWithUqOut>;

const TrainOut = z.object({
  model_id: z.string(),
  n_train: z.number().int(),
  cached_for_seconds: z.number().int(),
});

interface TrainingRow {
  rxn_smiles: string;
  yield_pct: number;
}

async function fetchTrainingPairs(
  pool: Pool,
  userEntraId: string,
  projectInternalId: string,
): Promise<TrainingRow[]> {
  return await withUserContext(pool, userEntraId, async (client) => {
    const result = await client.query<TrainingRow>(
      `SELECT r.rxn_smiles, e.yield_pct::float AS yield_pct
         FROM reactions r
         JOIN experiments e ON e.id = r.experiment_id
         JOIN synthetic_steps s ON s.id = e.synthetic_step_id
         JOIN nce_projects p ON p.id = s.nce_project_id
        WHERE p.internal_id = $1
          AND e.yield_pct IS NOT NULL
          AND r.rxn_smiles IS NOT NULL
        LIMIT $2`,
      [projectInternalId, MAX_TRAIN_PAIRS],
    );
    return result.rows;
  });
}

// ---------- Factory --------------------------------------------------------

export function buildPredictYieldWithUqTool(pool: Pool, mcpUrl: string) {
  const base = mcpUrl.replace(/\/$/, "");

  async function trainAndGetModelId(
    projectInternalId: string,
    pairs: TrainingRow[],
  ): Promise<string> {
    const resp = await postJson(
      `${base}/train`,
      {
        project_internal_id: projectInternalId,
        training_pairs: pairs,
      },
      TrainOut,
      120_000,
      "mcp-yield-baseline",
    );
    return resp.model_id;
  }

  return defineTool({
    id: "predict_yield_with_uq",
    description:
      "Predict yield with calibrated uncertainty for a list of reaction SMILES. " +
      "Combines chemprop's MVE-head std (aleatoric) with chemprop↔XGBoost " +
      "disagreement (epistemic) into a single ensemble_std. Per-project XGBoost " +
      "trained on the user's RLS-scoped reactions; falls back to a global " +
      "pretrained model when project has < 50 labeled reactions.",
    inputSchema: PredictYieldWithUqIn,
    outputSchema: PredictYieldWithUqOut,
    annotations: { readOnly: true },

    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) {
        throw new Error("predict_yield_with_uq requires userEntraId in context");
      }

      let modelId: string | null = null;
      let useGlobalFallback = true;
      let trainingPairs: TrainingRow[] = [];

      if (input.project_internal_id) {
        trainingPairs = await fetchTrainingPairs(
          pool,
          userEntraId,
          input.project_internal_id,
        );
        if (trainingPairs.length >= MIN_TRAIN_PAIRS) {
          modelId = await trainAndGetModelId(input.project_internal_id, trainingPairs);
          useGlobalFallback = false;
        }
      }

      const predictBody = {
        rxn_smiles_list: input.rxn_smiles_list,
        project_internal_id: input.project_internal_id ?? null,
        model_id: modelId,
        used_global_fallback: useGlobalFallback,
      };

      try {
        return await postJson(
          `${base}/predict_yield`,
          predictBody,
          PredictYieldWithUqOut,
          60_000,
          "mcp-yield-baseline",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 412 → cache miss after restart; re-train and retry once.
        if (msg.includes("412") && !useGlobalFallback && input.project_internal_id) {
          modelId = await trainAndGetModelId(input.project_internal_id, trainingPairs);
          return await postJson(
            `${base}/predict_yield`,
            { ...predictBody, model_id: modelId },
            PredictYieldWithUqOut,
            60_000,
            "mcp-yield-baseline",
          );
        }
        throw err;
      }
    },
  });
}
