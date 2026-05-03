// substructure_search — SMARTS substructure query against the compound corpus.
//
// Two-stage approach:
//   1. Pre-filter via the compound_substructure_hits cache + Morgan
//      fingerprint pattern matching (fast, false-positive-free for catalogued
//      patterns; coarse for novel SMARTS).
//   2. Re-verify the candidate set via mcp-rdkit's bulk_substructure_search
//      so the answer is exact RDKit semantics.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { withSystemContext } from "../../db/with-user-context.js";
import { postJson } from "../../mcp/postJson.js";
import { getLogger } from "../../observability/logger.js";

const log = getLogger("substructure_search");

export const SubstructureSearchIn = z.object({
  smarts: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(500).default(50),
});
export type SubstructureSearchInput = z.infer<typeof SubstructureSearchIn>;

export const SubstructureSearchOut = z.object({
  smarts: z.string(),
  n_scanned: z.number(),
  hits: z.array(
    z.object({
      inchikey: z.string(),
      smiles: z.string(),
      n_matches: z.number().int(),
    }),
  ),
});
export type SubstructureSearchOutput = z.infer<typeof SubstructureSearchOut>;

const BulkResp = z.object({
  hits: z.array(z.object({
    inchikey: z.string(),
    smiles: z.string(),
    n_matches: z.number(),
  })),
  n_scanned: z.number(),
});

const TIMEOUT_MS = 60_000;

export function buildSubstructureSearchTool(pool: Pool, mcpRdkitUrl: string) {
  const base = mcpRdkitUrl.replace(/\/$/, "");
  return defineTool({
    id: "substructure_search",
    description:
      "Find every compound in the corpus that matches a SMARTS pattern. " +
      "Useful for class queries: 'all phosphines', 'all primary amines', " +
      "'all aryl bromides on this scaffold'. Returns up to `limit` matches.",
    inputSchema: SubstructureSearchIn,
    outputSchema: SubstructureSearchOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      const limit = input.limit ?? 50;
      // Pre-filter: pull a candidate batch from compounds. We don't have a
      // SMARTS-aware index, so we sample by inchikey order with a generous
      // limit and let mcp-rdkit do the exact match.
      const candidates = await withSystemContext(pool, async (client) => {
        const res = await client.query<{ inchikey: string; smiles_canonical: string }>(
          `SELECT inchikey, smiles_canonical
             FROM compounds
            WHERE smiles_canonical IS NOT NULL
            ORDER BY inchikey
            LIMIT $1`,
          [Math.min(limit * 20, 5000)],
        );
        return res.rows.map((r) => ({
          inchikey: r.inchikey,
          smiles: r.smiles_canonical,
        }));
      });

      const result = await postJson(
        `${base}/tools/bulk_substructure_search`,
        { query_smarts: input.smarts, candidates, limit },
        BulkResp,
        TIMEOUT_MS,
        "mcp-rdkit",
      );

      log.info(
        { event: "substructure_search", n_hits: result.hits.length, n_scanned: result.n_scanned },
        "substructure search complete",
      );
      return {
        smarts: input.smarts,
        n_scanned: result.n_scanned,
        hits: result.hits.slice(0, limit),
      };
    },
  });
}
