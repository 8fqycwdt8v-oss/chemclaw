// recommend_conditions — wraps mcp-askcos /recommend_conditions.
//
// Phase Z0 of the reaction-condition-prediction stack: given a target reaction
// (reactants + product SMILES), return top-k condition sets (catalyst / reagent
// / solvent / temperature) ranked by the upstream ASKCOS recommender's score.
// Later phases gate the output on applicability-domain and green-chemistry
// signals; this builtin is the deterministic recommender call.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { MAX_SMILES_LEN } from "../_limits.js";

// ---------- Schemas ----------------------------------------------------------

export const RecommendConditionsIn = z.object({
  reactants_smiles: z
    .string()
    .min(1)
    .max(MAX_SMILES_LEN)
    .describe(
      "Dot-separated SMILES of the reactants (e.g. 'Brc1ccc(OC)cc1.C1COCCN1').",
    ),
  product_smiles: z
    .string()
    .min(1)
    .max(MAX_SMILES_LEN)
    .describe("SMILES of the desired product."),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Number of condition sets to return (1-20, default 5)."),
});
export type RecommendConditionsInput = z.infer<typeof RecommendConditionsIn>;

const CompoundRef = z.object({
  smiles: z.string(),
  name: z.string(),
});

const ConditionSet = z.object({
  catalysts: z.array(CompoundRef),
  reagents: z.array(CompoundRef),
  solvents: z.array(CompoundRef),
  temperature_c: z.number().nullable(),
  score: z.number().min(0).max(1),
});

export const RecommendConditionsOut = z.object({
  recommendations: z.array(ConditionSet),
  model_id: z.string(),
});
export type RecommendConditionsOutput = z.infer<typeof RecommendConditionsOut>;

// ---------- Timeout ----------------------------------------------------------

// ASKCOS recommender is GPU-backed; allow generous headroom.
const TIMEOUT_MS = 60_000;

// ---------- Factory ----------------------------------------------------------

export function buildRecommendConditionsTool(mcpAskcosUrl: string) {
  const base = mcpAskcosUrl.replace(/\/$/, "");

  return defineTool({
    id: "recommend_conditions",
    description:
      "Propose top-k reaction condition sets {catalysts, reagents, solvents, " +
      "temperature_c, score} for a target transformation, given reactants and " +
      "product SMILES. Backed by the ASKCOS condition recommender (Coley/Gao " +
      "2018 + 2024 refresh, USPTO-trained). Output should be applicability-" +
      "domain-checked before reporting to the user.",
    inputSchema: RecommendConditionsIn,
    outputSchema: RecommendConditionsOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      return await postJson(
        `${base}/recommend_conditions`,
        {
          reactants_smiles: input.reactants_smiles,
          product_smiles: input.product_smiles,
          top_k: input.top_k,
        },
        RecommendConditionsOut,
        TIMEOUT_MS,
        "mcp-askcos",
      );
    },
  });
}
