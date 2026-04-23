// Tool: search_knowledge
//
// Composite hybrid retrieval over `document_chunks` under the caller's RLS
// scope. Three modes, selectable by the agent:
//   - "dense"  → pgvector cosine search only (BGE-M3 embeddings)
//   - "sparse" → pg_trgm similarity search only
//   - "hybrid" → both, fused via Reciprocal Rank Fusion (k=60, standard)
//
// The default is "hybrid" — it almost always wins on retrieval quality for
// a mix of keyword and semantic queries.
//
// RLS scoping: document_chunks does not itself carry project metadata, so
// we scope indirectly: for chunks whose parent document carries a
// project-link in metadata (future columns). Until that link exists, all
// ingested documents are treated as organization-wide (visible to all
// authenticated users). A future sprint adds `documents.nce_project_id`
// and the accompanying RLS policy.

import { z } from "zod";
import type { Pool } from "pg";

import type { McpEmbedderClient } from "../mcp-clients.js";
import { withUserContext } from "../db.js";

export const SearchKnowledgeInput = z.object({
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
export type SearchKnowledgeInput = z.infer<typeof SearchKnowledgeInput>;

export const KnowledgeHit = z.object({
  chunk_id: z.string().uuid(),
  document_id: z.string().uuid(),
  heading_path: z.string().nullable(),
  text: z.string(),
  source_type: z.string(),
  document_title: z.string().nullable(),
  score: z.number(),
});
export type KnowledgeHit = z.infer<typeof KnowledgeHit>;

export const SearchKnowledgeOutput = z.object({
  mode: z.enum(["hybrid", "dense", "sparse"]),
  hits: z.array(KnowledgeHit),
});
export type SearchKnowledgeOutput = z.infer<typeof SearchKnowledgeOutput>;

export interface SearchKnowledgeDeps {
  pool: Pool;
  embedder: McpEmbedderClient;
  userEntraId: string;
}

// RRF standard offset — higher values = less aggressive head bias.
const _RRF_K = 60;

function toVectorLiteral(vec: number[]): string {
  // Format with bounded precision to keep the wire payload small.
  return "[" + vec.map((v) => v.toFixed(8)).join(",") + "]";
}

interface RawRow {
  chunk_id: string;
  document_id: string;
  heading_path: string | null;
  text: string;
  source_type: string;
  document_title: string | null;
  distance?: number;
  trgm_sim?: number;
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
           similarity(dc.text, $1::text) AS trgm_sim
      FROM document_chunks dc
      JOIN documents d ON d.id = dc.document_id
     WHERE dc.text %% $1::text
       AND ($2::text[] IS NULL OR d.source_type = ANY($2::text[]))
     ORDER BY similarity(dc.text, $1::text) DESC
     LIMIT $3::int
    `,
    [query, sourceTypes ?? null, k],
  );
  return r.rows as RawRow[];
}

/**
 * Reciprocal Rank Fusion (Cormack, Clarke & Buettcher 2009).
 * For each document, sum 1 / (k + rank_i) across all rankings it appears in.
 */
function reciprocalRankFusion(
  rankings: RawRow[][],
  k: number,
  limit: number,
): KnowledgeHit[] {
  const scores = new Map<string, { hit: RawRow; score: number }>();
  for (const ranking of rankings) {
    ranking.forEach((row, idx) => {
      const prev = scores.get(row.chunk_id);
      const inc = 1 / (k + idx + 1); // ranks are 1-based in RRF
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
    .map(({ hit, score }) => ({
      chunk_id: hit.chunk_id,
      document_id: hit.document_id,
      heading_path: hit.heading_path,
      text: hit.text,
      source_type: hit.source_type,
      document_title: hit.document_title,
      score: Number(score.toFixed(6)),
    }));
}

export async function searchKnowledge(
  input: SearchKnowledgeInput,
  deps: SearchKnowledgeDeps,
): Promise<SearchKnowledgeOutput> {
  const parsed = SearchKnowledgeInput.parse(input);
  const sourceTypes = parsed.source_types ?? null;

  // Dense embedding (skip for pure-sparse mode to save a network call).
  let embedding: number[] | null = null;
  if (parsed.mode !== "sparse") {
    const resp = await deps.embedder.embed([parsed.query], true);
    if (!resp.vectors[0] || resp.vectors[0].length === 0) {
      throw new Error("embedder returned empty vector");
    }
    embedding = resp.vectors[0];
  }

  const rows = await withUserContext(deps.pool, deps.userEntraId, async (client) => {
    switch (parsed.mode) {
      case "dense": {
        const dense = await denseSearch(client, embedding!, parsed.k, sourceTypes ?? undefined);
        return dense.map(
          (r): KnowledgeHit => ({
            chunk_id: r.chunk_id,
            document_id: r.document_id,
            heading_path: r.heading_path,
            text: r.text,
            source_type: r.source_type,
            document_title: r.document_title,
            score: 1 - Number(r.distance ?? 0),
          }),
        );
      }
      case "sparse": {
        const sparse = await sparseSearch(client, parsed.query, parsed.k, sourceTypes ?? undefined);
        return sparse.map(
          (r): KnowledgeHit => ({
            chunk_id: r.chunk_id,
            document_id: r.document_id,
            heading_path: r.heading_path,
            text: r.text,
            source_type: r.source_type,
            document_title: r.document_title,
            score: Number(r.trgm_sim ?? 0),
          }),
        );
      }
      default: {
        const [dense, sparse] = await Promise.all([
          denseSearch(client, embedding!, parsed.k * 2, sourceTypes ?? undefined),
          sparseSearch(client, parsed.query, parsed.k * 2, sourceTypes ?? undefined),
        ]);
        return reciprocalRankFusion([dense, sparse], _RRF_K, parsed.k);
      }
    }
  });

  return SearchKnowledgeOutput.parse({
    mode: parsed.mode,
    hits: rows,
  });
}

// Export the RRF helper so tests can lock down its behaviour without
// a live database.
export const _rrfForTests = reciprocalRankFusion;
