// qm_fukui — per-atom Fukui indices (f+, f-, f0) for reactivity prediction.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { QmRequestBase, QmResponseBase } from "./_qm_base.js";

export const QmFukuiIn = QmRequestBase;
export type QmFukuiInput = z.infer<typeof QmFukuiIn>;

export const QmFukuiOut = QmResponseBase.extend({
  f_plus: z.array(z.number()),
  f_minus: z.array(z.number()),
  f_zero: z.array(z.number()),
});
export type QmFukuiOutput = z.infer<typeof QmFukuiOut>;

const TIMEOUT_MS = 60_000;

export function buildQmFukuiTool(mcpXtbUrl: string) {
  const base = mcpXtbUrl.replace(/\/$/, "");
  return defineTool({
    id: "qm_fukui",
    description:
      "Per-atom Fukui reactivity indices (f+, f-, f0) for a SMILES. f+ marks " +
      "electrophilic attack sites, f- nucleophilic, f0 radical. Use for " +
      "selectivity hypotheses (e.g. predicting which CH gets oxidized).",
    inputSchema: QmFukuiIn,
    outputSchema: QmFukuiOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      return await postJson(
        `${base}/fukui`,
        input,
        QmFukuiOut,
        TIMEOUT_MS,
        "mcp-xtb",
      );
    },
  });
}
