// qm_redox_potential — IPEA-xTB vertical IE/EA -> redox potential (V vs SHE/Fc).

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";

export const QmRedoxIn = z.object({
  smiles: z.string().min(1).max(10_000),
  charge: z.number().int().default(0),
  multiplicity: z.number().int().min(1).default(1),
  solvent_model: z.enum(["none", "alpb", "gbsa", "cpcmx"]).default("none"),
  solvent_name: z.string().optional(),
  electrons: z.number().int().default(1),
  reference: z.enum(["SHE", "Fc"]).default("SHE"),
  force_recompute: z.boolean().default(false),
});
export type QmRedoxInput = z.infer<typeof QmRedoxIn>;

export const QmRedoxOut = z.object({
  job_id: z.string().nullable(),
  cache_hit: z.boolean(),
  status: z.string(),
  summary: z.string(),
  method: z.string(),
  task: z.string(),
  redox_potential_V: z.number().nullable(),
  vertical_ie_eV: z.number().nullable(),
  vertical_ea_eV: z.number().nullable(),
  reference: z.string(),
});
export type QmRedoxOutput = z.infer<typeof QmRedoxOut>;

const TIMEOUT_MS = 120_000;

export function buildQmRedoxTool(mcpXtbUrl: string) {
  const base = mcpXtbUrl.replace(/\/$/, "");
  return defineTool({
    id: "qm_redox_potential",
    description:
      "Vertical IE / EA via IPEA-xTB and a crude single-electron redox potential " +
      "(V) vs SHE or ferrocene. Useful for ranking electrochemical reactivity of " +
      "ligands / mediators / substrates. NOT a substitute for DFT-level redox " +
      "calculations on systems where 0.1 V matters.",
    inputSchema: QmRedoxIn,
    outputSchema: QmRedoxOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      return await postJson(
        `${base}/redox`,
        input,
        QmRedoxOut,
        TIMEOUT_MS,
        "mcp-xtb",
      );
    },
  });
}
