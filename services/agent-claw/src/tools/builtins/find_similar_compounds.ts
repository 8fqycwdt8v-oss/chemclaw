// find_similar_compounds — Tanimoto / cosine similarity over the compounds corpus.
//
// Uses the fingerprint columns (morgan_r2, morgan_r3, maccs, atompair) added
// by db/init/24_compound_fingerprints.sql + the compound_fingerprinter
// projector. The agent picks which fingerprint family to query against;
// Morgan-r2 is the most common default for "drug-like similarity".

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { withSystemContext } from "../../db/with-user-context.js";
import { postJson } from "../../mcp/postJson.js";
import { getLogger } from "../../observability/logger.js";

const log = getLogger("find_similar_compounds");

export const FindSimilarCompoundsIn = z.object({
  smiles: z.string().min(1).max(10_000),
  fingerprint: z
    .enum(["morgan_r2", "morgan_r3", "maccs", "atompair"])
    .default("morgan_r2"),
  k: z.number().int().min(1).max(100).default(20),
  min_similarity: z.number().min(0).max(1).default(0.0),
});
export type FindSimilarCompoundsInput = z.infer<typeof FindSimilarCompoundsIn>;

export const FindSimilarCompoundsOut = z.object({
  fingerprint: z.string(),
  hits: z.array(
    z.object({
      inchikey: z.string(),
      smiles_canonical: z.string().nullable(),
      similarity: z.number(),
    }),
  ),
});
export type FindSimilarCompoundsOutput = z.infer<typeof FindSimilarCompoundsOut>;

const MorganOut = z.object({ n_bits: z.number(), on_bits: z.array(z.number()) });

const TIMEOUT_MS = 15_000;

export function buildFindSimilarCompoundsTool(pool: Pool, mcpRdkitUrl: string) {
  const base = mcpRdkitUrl.replace(/\/$/, "");
  return defineTool({
    id: "find_similar_compounds",
    description:
      "Find the K nearest compounds to a query SMILES by chemical similarity. " +
      "Uses fingerprint-vector cosine search over the compounds corpus " +
      "(morgan_r2 is the typical default for drug-like similarity; pick maccs " +
      "for functional-group similarity). Returns inchikey + smiles + similarity.",
    inputSchema: FindSimilarCompoundsIn,
    outputSchema: FindSimilarCompoundsOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      // Zod defaults — coerce to concrete values.
      const fingerprint = input.fingerprint ?? "morgan_r2";
      const k = input.k ?? 20;
      const minSimilarity = input.min_similarity ?? 0.0;

      // 1. Get fingerprint of the query molecule from mcp-rdkit.
      const fpReq =
        fingerprint === "maccs"
          ? { smiles: input.smiles }
          : fingerprint === "atompair"
            ? { smiles: input.smiles, n_bits: 2048 }
            : { smiles: input.smiles, radius: fingerprint === "morgan_r3" ? 3 : 2, n_bits: 2048 };
      const fpPath =
        fingerprint === "maccs"
          ? "/tools/maccs_fingerprint"
          : fingerprint === "atompair"
            ? "/tools/atompair_fingerprint"
            : "/tools/morgan_fingerprint";
      const fp = await postJson(`${base}${fpPath}`, fpReq, MorganOut, TIMEOUT_MS, "mcp-rdkit");
      const queryVec = onBitsToPgvectorLiteral(fp.on_bits, fp.n_bits);

      // 2. Cosine search the matching column.
      const column = fingerprint;
      const rows = await withSystemContext(pool, async (client) => {
        const res = await client.query<{
          inchikey: string;
          smiles_canonical: string | null;
          similarity: number;
        }>(
          `SELECT inchikey,
                  smiles_canonical,
                  1 - (${column} <=> $1::vector) AS similarity
             FROM compounds
            WHERE ${column} IS NOT NULL
            ORDER BY ${column} <=> $1::vector ASC
            LIMIT $2`,
          [queryVec, k],
        );
        return res.rows;
      });

      const filtered = rows.filter((r) => r.similarity >= minSimilarity);
      log.info(
        { event: "find_similar_compounds", n_hits: filtered.length, k },
        "similarity search complete",
      );
      return {
        fingerprint,
        hits: filtered,
      };
    },
  });
}

function onBitsToPgvectorLiteral(onBits: number[], nBits: number): string {
  const bits = new Array<number>(nBits).fill(0);
  for (const b of onBits) {
    if (b >= 0 && b < nBits) bits[b] = 1;
  }
  return `[${bits.join(",")}]`;
}
