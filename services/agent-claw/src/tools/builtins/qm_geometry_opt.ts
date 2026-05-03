// qm_geometry_opt — wraps mcp-xtb /geometry_opt with full method choice.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { QmRequestBase, QmResponseBase } from "./_qm_base.js";

export const QmGeometryOptIn = QmRequestBase.extend({
  threshold: z.enum(["crude", "loose", "normal", "tight", "vtight"]).default("tight"),
});
export type QmGeometryOptInput = z.infer<typeof QmGeometryOptIn>;

export const QmGeometryOptOut = QmResponseBase.extend({
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
