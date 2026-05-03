// qm_single_point — wraps mcp-xtb /single_point.
//
// Returns the cached job_id when available so the LLM can refer to the
// stored result by id (the qm_kg projector mints a Neo4j CalculationResult
// node per succeeded job, so downstream KG queries can join on it).
//
// Latency: ~1-3 s per call for typical small molecules; <100 ms on cache hit.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";

const QmMethod = z.enum([
  "GFN0",
  "GFN1",
  "GFN2",
  "GFN-FF",
  "g-xTB",
  "sTDA-xTB",
  "IPEA-xTB",
]);

const SolventModel = z.enum(["none", "alpb", "gbsa", "cpcmx"]);

export const QmSinglePointIn = z.object({
  smiles: z.string().min(1).max(10_000),
  method: QmMethod.default("GFN2"),
  charge: z.number().int().default(0),
  multiplicity: z.number().int().min(1).default(1),
  solvent_model: SolventModel.default("none"),
  solvent_name: z.string().optional(),
  force_recompute: z.boolean().default(false).describe(
    "Bypass the QM cache and force a fresh xTB run. Use sparingly.",
  ),
});
export type QmSinglePointInput = z.infer<typeof QmSinglePointIn>;

export const QmSinglePointOut = z.object({
  job_id: z.string().nullable(),
  cache_hit: z.boolean(),
  status: z.string(),
  summary: z.string(),
  method: z.string(),
  task: z.string(),
  energy_hartree: z.number().nullable(),
  homo_lumo_eV: z.number().nullable().optional(),
  dipole: z.array(z.number()).nullable().optional(),
});
export type QmSinglePointOutput = z.infer<typeof QmSinglePointOut>;

const TIMEOUT_MS = 30_000;

export function buildQmSinglePointTool(mcpXtbUrl: string) {
  const base = mcpXtbUrl.replace(/\/$/, "");
  return defineTool({
    id: "qm_single_point",
    description:
      "Compute a single-point energy for a SMILES with the chosen tight-binding method " +
      "(GFN0/1/2, GFN-FF, g-xTB, sTDA-xTB, IPEA-xTB). Returns energy (Hartree), " +
      "HOMO-LUMO gap (eV), and dipole. Cached by (method, smiles, charge, mult, " +
      "solvent_model, params); cache hit returns in <100 ms. Use as a fast " +
      "screening primitive before geometry opt or frequencies.",
    inputSchema: QmSinglePointIn,
    outputSchema: QmSinglePointOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      return await postJson(
        `${base}/single_point`,
        input,
        QmSinglePointOut,
        TIMEOUT_MS,
        "mcp-xtb",
      );
    },
  });
}
