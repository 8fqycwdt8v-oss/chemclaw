// find_matched_pairs — wraps mcp-genchem /mmp_search.
//
// Returns matched-molecular-pairs from the MMP corpus. Useful for
// SAR-transfer hypotheses ("X→Y substitution gave +1 logP in 12
// reactions; this molecule has the X site").

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";

export const FindMatchedPairsIn = z.object({
  smiles: z.string().min(1).max(10_000),
  n: z.number().int().min(1).max(200).default(20),
});
export type FindMatchedPairsInput = z.infer<typeof FindMatchedPairsIn>;

export const FindMatchedPairsOut = z.object({
  pairs: z.array(z.object({
    lhs_inchikey: z.string(),
    rhs_inchikey: z.string(),
    transformation_smarts: z.string(),
    delta_property: z.record(z.string(), z.unknown()),
  })),
});
export type FindMatchedPairsOutput = z.infer<typeof FindMatchedPairsOut>;

const TIMEOUT_MS = 30_000;

export function buildFindMatchedPairsTool(mcpGenchemUrl: string) {
  const base = mcpGenchemUrl.replace(/\/$/, "");
  return defineTool({
    id: "find_matched_pairs",
    description:
      "Look up matched-molecular-pairs (MMPs) for a SMILES from the corpus. " +
      "Returns pairs of (lhs, rhs) compounds + the transformation_smarts that " +
      "links them, plus any recorded delta properties (e.g. delta_logP). " +
      "Useful for SAR-transfer hypotheses.",
    inputSchema: FindMatchedPairsIn,
    outputSchema: FindMatchedPairsOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      return await postJson(
        `${base}/mmp_search`,
        { query_smiles: input.smiles, n: input.n ?? 20 },
        FindMatchedPairsOut,
        TIMEOUT_MS,
        "mcp-genchem",
      );
    },
  });
}
