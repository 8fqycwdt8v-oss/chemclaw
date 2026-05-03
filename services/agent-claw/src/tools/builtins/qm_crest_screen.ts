// qm_crest_screen — CREST conformer / tautomer / protomer ensemble (mcp-crest).
//
// One builtin covers all three modes via the `mode` parameter. Returns the
// ensemble (xyz + energy + Boltzmann weight per structure) AND the persisted
// job_id so the agent can refer to "the conformers from job X" in later turns.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";

export const QmCrestScreenIn = z.object({
  smiles: z.string().min(1).max(10_000),
  mode: z.enum(["conformers", "tautomers", "protomers"]).default("conformers"),
  method: z.enum(["GFN2", "GFN-FF"]).default("GFN2"),
  charge: z.number().int().default(0),
  multiplicity: z.number().int().min(1).default(1),
  solvent_model: z.enum(["none", "alpb", "gbsa"]).default("none"),
  solvent_name: z.string().optional(),
  threads: z.number().int().min(1).max(32).default(4),
  n_max: z.number().int().min(1).max(200).default(20),
  force_recompute: z.boolean().default(false),
});
export type QmCrestScreenInput = z.infer<typeof QmCrestScreenIn>;

const EnsembleEntry = z.object({
  ensemble_index: z.number().int(),
  xyz: z.string(),
  energy_hartree: z.number(),
  boltzmann_weight: z.number(),
});

export const QmCrestScreenOut = z.object({
  job_id: z.string().nullable(),
  cache_hit: z.boolean(),
  method: z.string(),
  task: z.string(),
  summary: z.string(),
  ensemble: z.array(EnsembleEntry),
});
export type QmCrestScreenOutput = z.infer<typeof QmCrestScreenOut>;

const TIMEOUT_MS = 600_000;

export function buildQmCrestScreenTool(mcpCrestUrl: string) {
  const base = mcpCrestUrl.replace(/\/$/, "");
  return defineTool({
    id: "qm_crest_screen",
    description:
      "CREST screen for a SMILES — pick mode='conformers' for low-energy " +
      "conformer ensembles, mode='tautomers' for tautomer enumeration, " +
      "mode='protomers' for protonation-state enumeration. Returns ranked " +
      "structures with Boltzmann weights. Latency 30 s - 10 min.",
    inputSchema: QmCrestScreenIn,
    outputSchema: QmCrestScreenOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      // Zod's .default("conformers") applies at parse time, but the
      // SDK-derived input type still includes undefined; coerce here so
      // the path interpolation never produces "/undefined".
      const mode = input.mode ?? "conformers";
      const path = `/${mode}`;
      const { mode: _mode, ...payload } = input;
      return await postJson(
        `${base}${path}`,
        payload,
        QmCrestScreenOut,
        TIMEOUT_MS,
        "mcp-crest",
      );
    },
  });
}
