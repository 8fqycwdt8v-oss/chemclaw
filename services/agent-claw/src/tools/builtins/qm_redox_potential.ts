// qm_redox_potential — IPEA-xTB vertical IE/EA -> redox potential (V vs SHE/Fc).

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { QmRequestBase, QmResponseBase } from "./_qm_base.js";

// Redox path always uses IPEA-xTB on the server; we omit the `method` field
// from the shared base and add the redox-specific knobs.
export const QmRedoxIn = QmRequestBase.omit({ method: true }).extend({
  electrons: z.number().int().default(1),
  reference: z.enum(["SHE", "Fc"]).default("SHE"),
});
export type QmRedoxInput = z.infer<typeof QmRedoxIn>;

export const QmRedoxOut = QmResponseBase.extend({
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
