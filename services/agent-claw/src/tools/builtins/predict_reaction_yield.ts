// predict_reaction_yield — wraps mcp-chemprop MPNN yield prediction.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { MAX_RXN_SMILES_LEN, MAX_BATCH_SMILES } from "../_limits.js";

// ---------- Schemas ----------------------------------------------------------

export const PredictReactionYieldIn = z.object({
  rxn_smiles_list: z
    .array(z.string().min(1).max(MAX_RXN_SMILES_LEN))
    .min(1)
    .max(MAX_BATCH_SMILES)
    .describe("List of reaction SMILES to predict yield for (max 100)."),
});
export type PredictReactionYieldInput = z.infer<typeof PredictReactionYieldIn>;

const YieldPrediction = z.object({
  rxn_smiles: z.string(),
  predicted_yield: z.number(),
  std: z.number(),
  model_id: z.string(),
});

export const PredictReactionYieldOut = z.object({
  predictions: z.array(YieldPrediction),
});
export type PredictReactionYieldOutput = z.infer<typeof PredictReactionYieldOut>;

// ---------- Timeout ----------------------------------------------------------

const TIMEOUT_MS = 60_000;

// ---------- Factory ----------------------------------------------------------

export function buildPredictReactionYieldTool(mcpChempropUrl: string) {
  const base = mcpChempropUrl.replace(/\/$/, "");

  return defineTool({
    id: "predict_reaction_yield",
    description:
      "Predict the expected yield for one or more reaction SMILES using the " +
      "chemprop v2 MPNN model. Returns predicted_yield (0-100) and uncertainty std.",
    inputSchema: PredictReactionYieldIn,
    outputSchema: PredictReactionYieldOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      return await postJson(
        `${base}/predict_yield`,
        { rxn_smiles_list: input.rxn_smiles_list },
        PredictReactionYieldOut,
        TIMEOUT_MS,
        "mcp-chemprop",
      );
    },
  });
}
