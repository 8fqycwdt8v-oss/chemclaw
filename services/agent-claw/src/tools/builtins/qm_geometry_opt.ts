// qm_geometry_opt — wraps mcp-xtb /geometry_opt with full method choice.

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

export const QmGeometryOptIn = z.object({
  smiles: z.string().min(1).max(10_000),
  method: QmMethod.default("GFN2"),
  charge: z.number().int().default(0),
  multiplicity: z.number().int().min(1).default(1),
  solvent_model: z.enum(["none", "alpb", "gbsa", "cpcmx"]).default("none"),
  solvent_name: z.string().optional(),
  threshold: z.enum(["crude", "loose", "normal", "tight", "vtight"]).default("tight"),
  force_recompute: z.boolean().default(false),
});
export type QmGeometryOptInput = z.infer<typeof QmGeometryOptIn>;

export const QmGeometryOptOut = z.object({
  job_id: z.string().nullable(),
  cache_hit: z.boolean(),
  status: z.string(),
  summary: z.string(),
  method: z.string(),
  task: z.string(),
  optimized_xyz: z.string(),
  energy_hartree: z.number().nullable(),
  gnorm: z.number().nullable(),
  converged: z.boolean(),
});
export type QmGeometryOptOutput = z.infer<typeof QmGeometryOptOut>;

const TIMEOUT_MS = 120_000;

export function buildQmGeometryOptTool(mcpXtbUrl: string) {
  const base = mcpXtbUrl.replace(/\/$/, "");
  return defineTool({
    id: "qm_geometry_opt",
    description:
      "Optimize molecular geometry with the chosen tight-binding method. " +
      "Returns the optimized XYZ block, energy (Hartree), gradient norm, and " +
      "convergence flag. Cached by (method, smiles, charge, mult, solvent_model, " +
      "threshold). Use before frequencies, single-point on optimized geometry, " +
      "or any property prediction that requires a minimum.",
    inputSchema: QmGeometryOptIn,
    outputSchema: QmGeometryOptOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      return await postJson(
        `${base}/geometry_opt`,
        input,
        QmGeometryOptOut,
        TIMEOUT_MS,
        "mcp-xtb",
      );
    },
  });
}
