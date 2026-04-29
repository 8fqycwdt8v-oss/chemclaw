// compute_conformer_ensemble — wraps mcp-xtb GFN2-xTB conformer search.
//
// Latency: ~30 s per call (CREST ensemble for typical drug-like molecules).
// Suitable for stereo/atropisomerism investigations.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";

// ---------- Schemas ----------------------------------------------------------

export const ComputeConformerEnsembleIn = z.object({
  smiles: z.string().min(1).max(10_000),
  n_conformers: z.number().int().min(1).max(100).default(20).describe(
    "Maximum number of conformers to return from the CREST ensemble.",
  ),
  method: z
    .enum(["GFN2-xTB", "GFN-FF"])
    .default("GFN2-xTB")
    .describe("Semi-empirical method for geometry optimization before CREST."),
  optimize_first: z.boolean().default(true).describe(
    "If true, run geometry optimization before conformer search.",
  ),
});
export type ComputeConformerEnsembleInput = z.infer<typeof ComputeConformerEnsembleIn>;

const ConformerEntry = z.object({
  xyz: z.string(),
  energy_hartree: z.number(),
  weight: z.number(),
});

export const ComputeConformerEnsembleOut = z.object({
  conformers: z.array(ConformerEntry),
});
export type ComputeConformerEnsembleOutput = z.infer<typeof ComputeConformerEnsembleOut>;

// ---------- Timeout ----------------------------------------------------------

// CREST can take 60–90 s for medium-sized molecules.
const TIMEOUT_MS = 120_000;

// ---------- Factory ----------------------------------------------------------

export function buildComputeConformerEnsembleTool(mcpXtbUrl: string) {
  const base = mcpXtbUrl.replace(/\/$/, "");

  return defineTool({
    id: "compute_conformer_ensemble",
    description:
      "Generate a Boltzmann-weighted conformer ensemble for a SMILES using GFN2-xTB + CREST. " +
      "Use for stereo, atropisomerism, or ring-flip questions. Latency ~30-60 s.",
    inputSchema: ComputeConformerEnsembleIn,
    outputSchema: ComputeConformerEnsembleOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      return postJson(
        `${base}/conformer_ensemble`,
        { smiles: input.smiles, n_conformers: input.n_conformers },
        ComputeConformerEnsembleOut,
        TIMEOUT_MS,
        "mcp-xtb",
      );
    },
  });
}
