// search_knowledge — Phase B.2 builtin.
//
// Hybrid dense+sparse retrieval over document_chunks, scoped to the user's
// RLS context. Mode:
//   "hybrid"  — dense + sparse fused via RRF (default, best quality)
//   "dense"   — BGE-M3 cosine only
//   "sparse"  — pg_trgm trigram similarity only
//
// Each hit is surfaced as a Citation with source_kind="document_chunk".

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";
import type { Citation } from "../../core/types.js";

// ---------- Schemas ----------------------------------------------------------

export const SearchKnowledgeIn = z.object({
  query: z.string().min(1).max(4_000),
  k: z.number().int().min(1).max(50).default(10),
  mode: z.enum(["hybrid", "dense", "sparse"]).default("hybrid"),
  source_types: z
    .array(
      z.enum([
        "SOP",
        "report",
        "method_validation",
        "literature_summary",
        "presentation",
        "spreadsheet",
        "other",
      ]),
    )
    .optional(),
});
export type SearchKnowledgeInput = z.infer<typeof SearchKnowledgeIn>;

export const KnowledgeHit = z.object({
  chunk_id: z.string().uuid(),
  document_id: z.string().uuid(),
  heading_path: z.string().nullable(),
  text: z.string(),
  source_type: z.string(),
  document_title: z.string().nullable(),
  score: z.number(),
  citation: z.custom<Citation>(),
});

export const SearchKnowledgeOut = z.object({
  mode: z.enum(["hybrid", "dense", "sparse"]),
  hits: z.array(KnowledgeHit),
});
export type SearchKnowledgeOutput = z.infer<typeof SearchKnowledgeOut>;

// mcp-embedder response schema.
const EmbedOut = z.object({
  vectors: z.array(z.array(z.number())),
});

// ---------- Internal row type ------------------------------------------------

interface RawRow {
  chunk_id: string;
  document_id: string;
  heading_path: string | null;
  text: string;
  source_type: string;
  document_title: string | null;
  original_uri: string | null;
  distance?: number;
  trgm_sim?: number;
}

// ---------- RRF constant -----------------------------------------------------

const _RRF_K = 60;

// ---------- Timeout ----------------------------------------------------------

const TIMEOUT_EMBED_MS = 15_000;

// ---------- Helpers ----------------------------------------------------------

function toVectorLiteral(vec: number[]): string {
  return "[" + vec.map((v) => v.toFixed(8)).join(",") + "]";
}

async function denseSearch(
  client: import("pg").PoolClient,
  embedding: number[],
  k: number,
  sourceTypes: string[] | undefined,
): Promise<RawRow[]> {
  const literal = toVectorLiteral(embedding);
  const r = await client.query(
    `
    SELECT dc.id::text AS chunk_id,
           dc.document_id::text AS document_id,
           dc.heading_path,
           dc.text,
           d.source_type,
           d.title AS document_title,
           d.original_uri,
           dc.embedding <=> $1::vector AS distance
      FROM document_chunks dc
      JOIN documents d ON d.id = dc.document_id
     WHERE dc.embedding IS NOT NULL
       AND ($2::text[] IS NULL OR d.source_type = ANY($2::text[]))
     ORDER BY dc.embedding <=> $1::vector ASC
     LIMIT $3::int
    `,
    [literal, sourceTypes ?? null, k],
  );
  return r.rows as RawRow[];
}

async function sparseSearch(
  client: import("pg").PoolClient,
  query: string,
  k: number,
  sourceTypes: string[] | undefined,
): Promise<RawRow[]> {
  const r = await client.query(
    `
    SELECT dc.id::text AS chunk_id,
           dc.document_id::text AS document_id,
           dc.heading_path,
           dc.text,
           d.source_type,
           d.title AS document_title,
           d.original_uri,
           similarity(dc.text, $1::text) AS trgm_sim
      FROM document_chunks dc
      JOIN documents d ON d.id = dc.document_id
     WHERE dc.text % $1::text
       AND ($2::text[] IS NULL OR d.source_type = ANY($2::text[]))
     ORDER BY similarity(dc.text, $1::text) DESC
     LIMIT $3::int
    `,
    [query, sourceTypes ?? null, k],
  );
  return r.rows as RawRow[];
}

function reciprocalRankFusion(
  rankings: RawRow[][],
  k: number,
  limit: number,
): Array<RawRow & { score: number }> {
  const scores = new Map<string, { hit: RawRow; score: number }>();
  for (const ranking of rankings) {
    ranking.forEach((row, idx) => {
      const prev = scores.get(row.chunk_id);
      const inc = 1 / (k + idx + 1);
      if (prev) {
        prev.score += inc;
      } else {
        scores.set(row.chunk_id, { hit: row, score: inc });
      }
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit, score }) => ({ ...hit, score: Number(score.toFixed(6)) }));
}

// Exposed for tests.
export const _rrfForTests = reciprocalRankFusion;

// ---------- Factory ----------------------------------------------------------

export function buildSearchKnowledgeTool(pool: Pool, mcpEmbedderUrl: string) {
  const base = mcpEmbedderUrl.replace(/\/$/, "");

  return defineTool({
    id: "search_knowledge",
    description:
      "Hybrid dense+sparse search over ingested documents. " +
      "mode='hybrid' (default) uses reciprocal rank fusion of BGE-M3 semantic search and trigram keyword search. " +
      "Optionally filter by source_types. Returns top-k chunks with citations.",
    inputSchema: SearchKnowledgeIn,
    outputSchema: SearchKnowledgeOut,

    execute: async (ctx, input) => {
      // Re-parse to materialise Zod .default() values so TypeScript sees
      // definite types (k: number, mode: string, etc.).
      const parsed = SearchKnowledgeIn.parse(input);
      const k = parsed.k;
      const mode = parsed.mode;
      const query = parsed.query;
      const sourceTypes = parsed.source_types ?? undefined;

      // Get embedding unless pure-sparse.
      let embedding: number[] | null = null;
      if (mode !== "sparse") {
        const resp = await postJson(
          `${base}/tools/embed`,
          { texts: [query], truncate: true },
          EmbedOut,
          TIMEOUT_EMBED_MS,
          "mcp-embedder",
        );
        if (!resp.vectors[0] || resp.vectors[0].length === 0) {
          throw new Error("embedder returned empty vector");
        }
        embedding = resp.vectors[0];
      }

      const rows = await withUserContext(pool, ctx.userEntraId, async (client) => {
        switch (mode) {
          case "dense": {
            const dense = await denseSearch(client, embedding!, k, sourceTypes);
            return dense.map((r) => ({ ...r, score: 1 - Number(r.distance ?? 0) }));
          }
          case "sparse": {
            const sparse = await sparseSearch(client, query, k, sourceTypes);
            return sparse.map((r) => ({ ...r, score: Number(r.trgm_sim ?? 0) }));
          }
          default: {
            const [dense, sparse] = await Promise.all([
              denseSearch(client, embedding!, k * 2, sourceTypes),
              sparseSearch(client, query, k * 2, sourceTypes),
            ]);
            return reciprocalRankFusion([dense, sparse], _RRF_K, k);
          }
        }
      });

      const hits = rows.map((r) => ({
        chunk_id: r.chunk_id,
        document_id: r.document_id,
        heading_path: r.heading_path,
        text: r.text,
        source_type: r.source_type,
        document_title: r.document_title,
        score: (r as { score: number }).score,
        citation: {
          source_id: r.chunk_id,
          source_kind: "document_chunk" as const,
          source_uri: r.original_uri ?? r.chunk_id,
          snippet: r.text.slice(0, 500),
        } satisfies Citation,
      }));

      return SearchKnowledgeOut.parse({ mode, hits });
    },
  });
}
