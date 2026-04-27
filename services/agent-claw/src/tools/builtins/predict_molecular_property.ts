// predict_molecular_property — wraps mcp-chemprop property prediction.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { MAX_SMILES_LEN, MAX_BATCH_SMILES } from "../_limits.js";

// ---------- Schemas ----------------------------------------------------------

const PropertyEnum = z.enum(["logP", "logS", "mp", "bp"]);

export const PredictMolecularPropertyIn = z.object({
  smiles_list: z
    .array(z.string().min(1).max(MAX_SMILES_LEN))
    .min(1)
    .max(MAX_BATCH_SMILES)
    .describe("List of SMILES to predict a property for (max 100)."),
  property: PropertyEnum.describe(
    "Molecular property to predict: logP, logS, mp (melting point °C), or bp (boiling point °C).",
  ),
});
export type PredictMolecularPropertyInput = z.infer<typeof PredictMolecularPropertyIn>;

const PropertyPrediction = z.object({
  smiles: z.string(),
  value: z.number(),
  std: z.number(),
});

export const PredictMolecularPropertyOut = z.object({
  predictions: z.array(PropertyPrediction),
});
export type PredictMolecularPropertyOutput = z.infer<typeof PredictMolecularPropertyOut>;

// ---------- Timeout ----------------------------------------------------------

const TIMEOUT_MS = 60_000;

// ---------- Factory ----------------------------------------------------------

export function buildPredictMolecularPropertyTool(mcpChempropUrl: string) {
  const base = mcpChempropUrl.replace(/\/$/, "");

  return defineTool({
    id: "predict_molecular_property",
    description:
      "Predict a molecular property (logP, logS, melting point, or boiling point) for " +
      "a list of SMILES using the chemprop v2 MPNN model. Returns predicted value with uncertainty.",
    inputSchema: PredictMolecularPropertyIn,
    outputSchema: PredictMolecularPropertyOut,

    execute: async (_ctx, input) => {
      return postJson(
        `${base}/predict_property`,
        { smiles_list: input.smiles_list, property: input.property },
        PredictMolecularPropertyOut,
        TIMEOUT_MS,
        "mcp-chemprop",
      );
    },
  });
}
