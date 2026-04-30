// score_green_chemistry — wraps mcp-green-chemistry /score_solvents.
//
// Phase Z1: thin pass-through. The skill (condition-design v2) applies the
// soft-greenness penalty in its own ranking math — this builtin just returns
// the per-solvent class data.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { MAX_SMILES_LEN } from "../_limits.js";

const SolventInput = z.object({
  smiles: z.string().min(1).max(MAX_SMILES_LEN).optional(),
  name: z.string().min(1).max(200).optional(),
});

export const ScoreGreenChemistryIn = z.object({
  solvents: z.array(SolventInput).min(1).max(50),
});
export type ScoreGreenChemistryInput = z.infer<typeof ScoreGreenChemistryIn>;

const SolventScore = z.object({
  input: SolventInput,
  canonical_smiles: z.string().nullable(),
  chem21_class: z.string().nullable(),
  chem21_score: z.number().nullable(),
  gsk_class: z.string().nullable(),
  pfizer_class: z.string().nullable(),
  az_class: z.string().nullable(),
  sanofi_class: z.string().nullable(),
  acs_unified_class: z.string().nullable(),
  match_confidence: z.string(),
});

export const ScoreGreenChemistryOut = z.object({
  results: z.array(SolventScore),
});
export type ScoreGreenChemistryOutput = z.infer<typeof ScoreGreenChemistryOut>;

const TIMEOUT_MS = 10_000;

export function buildScoreGreenChemistryTool(mcpUrl: string) {
  const base = mcpUrl.replace(/\/$/, "");
  return defineTool({
    id: "score_green_chemistry",
    description:
      "Score a list of solvents against CHEM21 / GSK / Pfizer / AZ / Sanofi / " +
      "ACS GCI-PR guides. Returns per-solvent class + score plus match_confidence " +
      "(smiles_exact / name_only / unmatched). Use BEFORE proposing conditions " +
      "to a chemist so the soft-greenness penalty in condition-design can apply.",
    inputSchema: ScoreGreenChemistryIn,
    outputSchema: ScoreGreenChemistryOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      return await postJson(
        `${base}/score_solvents`,
        { solvents: input.solvents },
        ScoreGreenChemistryOut,
        TIMEOUT_MS,
        "mcp-green-chemistry",
      );
    },
  });
}
