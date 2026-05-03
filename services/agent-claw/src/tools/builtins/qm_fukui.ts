// qm_fukui — per-atom Fukui indices (f+, f-, f0) for reactivity prediction.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";

const QmMethod = z.enum([
  "GFN0", "GFN1", "GFN2", "GFN-FF", "g-xTB",
]);

export const QmFukuiIn = z.object({
  smiles: z.string().min(1).max(10_000),
  method: QmMethod.default("GFN2"),
  charge: z.number().int().default(0),
  multiplicity: z.number().int().min(1).default(1),
  force_recompute: z.boolean().default(false),
});
export type QmFukuiInput = z.infer<typeof QmFukuiIn>;

export const QmFukuiOut = z.object({
  job_id: z.string().nullable(),
  cache_hit: z.boolean(),
  status: z.string(),
  summary: z.string(),
  method: z.string(),
  task: z.string(),
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
