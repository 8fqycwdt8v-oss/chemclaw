// search_knowledge — Phase B.2 builtin (+ ADR 012 Phase 3c: knowledge-wiki arm).
//
// Hybrid dense+sparse retrieval over document_chunks AND knowledge-wiki pages
// (wiki_chunks), scoped to the user's RLS context. Mode:
//   "hybrid"  — dense + sparse fused via RRF (default, best quality)
//   "dense"   — BGE-M3 cosine only
//   "sparse"  — pg_trgm trigram similarity only
//
// `include_wiki` (default true) adds a wiki_chunks arm so a synthesised
// knowledge-wiki page surfaces alongside raw document chunks — prefer reading
// a `kind: "wiki"` hit over re-deriving from scattered doc chunks. Each hit is
// a Citation with source_kind="document_chunk" or "knowledge_article".

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";
import type { Citation } from "../../core/types.js";
import { rrfMerge } from "../../core/rrf.js";
import { normalizeUrl } from "../../mcp/normalize-url.js";

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
  /** Also search knowledge-wiki pages (wiki_chunks). Default true — prefer a
   *  synthesised `kind:"wiki"` hit over re-deriving from raw doc chunks. */
  include_wiki: z.boolean().default(true),
});
export type SearchKnowledgeInput = z.infer<typeof SearchKnowledgeIn>;

export const KnowledgeHit = z.object({
  /** "document" — a document_chunks row; "wiki" — a knowledge-wiki page chunk. */
  kind: z.enum(["document", "wiki"]),
  chunk_id: z.string().uuid(),
  /** Set for document hits; null for wiki hits. */
  document_id: z.string().uuid().nullable(),
  /** Set for wiki hits (the knowledge_articles id); null for document hits. */
  article_id: z.string().uuid().nullable(),
  /** Set for wiki hits (the page slug); null for document hits. */
  slug: z.string().nullable(),
  heading_path: z.string().nullable(),
  text: z.string(),
  /** document source_type (SOP/report/…) for document hits; the article kind
   *  (nce_project/compound/…) for wiki hits. */
  source_type: z.string(),
  /** document title for document hits; article title for wiki hits. */
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

// ---------- Internal row types -----------------------------------------------

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

interface RawWikiRow {
  /** discriminator — present only on wiki rows. */
  is_wiki: true;
  chunk_id: string;
  article_id: string;
  slug: string;
  article_kind: string;
  article_title: string | null;
  heading_path: string | null;
  text: string;
  distance?: number;
  trgm_sim?: number;
}

type AnyRow = RawRow | RawWikiRow;

function isWikiRow(r: AnyRow): r is RawWikiRow {
  return "is_wiki" in r;
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

async function denseWikiSearch(
  client: import("pg").PoolClient,
  embedding: number[],
  k: number,
): Promise<RawWikiRow[]> {
  const literal = toVectorLiteral(embedding);
  const r = await client.query(
    `
    SELECT wc.id::text AS chunk_id,
           wc.article_id::text AS article_id,
           wc.slug,
           ka.kind AS article_kind,
           ka.title AS article_title,
           wc.heading_path,
           wc.text,
           wc.embedding <=> $1::vector AS distance
      FROM wiki_chunks wc
      JOIN knowledge_articles ka ON ka.id = wc.article_id
     WHERE wc.embedding IS NOT NULL
       AND ka.status = 'current'
     ORDER BY wc.embedding <=> $1::vector ASC
     LIMIT $2::int
    `,
    [literal, k],
  );
  return (r.rows as Omit<RawWikiRow, "is_wiki">[]).map((row) => ({ ...row, is_wiki: true as const }));
}

async function sparseWikiSearch(
  client: import("pg").PoolClient,
  query: string,
  k: number,
): Promise<RawWikiRow[]> {
  const r = await client.query(
    `
    SELECT wc.id::text AS chunk_id,
           wc.article_id::text AS article_id,
           wc.slug,
           ka.kind AS article_kind,
           ka.title AS article_title,
           wc.heading_path,
           wc.text,
           similarity(wc.text, $1::text) AS trgm_sim
      FROM wiki_chunks wc
      JOIN knowledge_articles ka ON ka.id = wc.article_id
     WHERE wc.text % $1::text
       AND ka.status = 'current'
     ORDER BY similarity(wc.text, $1::text) DESC
     LIMIT $2::int
    `,
    [query, k],
  );
  return (r.rows as Omit<RawWikiRow, "is_wiki">[]).map((row) => ({ ...row, is_wiki: true as const }));
}

function reciprocalRankFusion(
  rankings: AnyRow[][],
  k: number,
  limit: number,
): Array<AnyRow & { score: number }> {
  // Tranche 3 / H1 cleanup: thin shim over the shared rrfMerge utility so
  // both the dense+sparse fusion here and the KG+vector fusion in
  // retrieve_related run through one implementation. The {chunk_id, …} →
  // {…, score} reshape is preserved as the existing public test
  // contract (see _rrfForTests below). ADR 012 Phase 3c: the rankings may
  // now mix document_chunks rows and wiki_chunks rows — `chunk_id` is a
  // UUID from disjoint tables, so the fusion key stays unambiguous.
  return rrfMerge(rankings, {
    key: (row) => row.chunk_id,
    k,
    limit,
  }).map(({ item, score }) => ({ ...item, score }));
}

// Exposed for tests.
export const _rrfForTests = reciprocalRankFusion;

// ---------- Factory ----------------------------------------------------------

export function buildSearchKnowledgeTool(pool: Pool, mcpEmbedderUrl: string) {
  const base = normalizeUrl(mcpEmbedderUrl);

  return defineTool({
    id: "search_knowledge",
    description:
      "Hybrid dense+sparse search over ingested documents AND knowledge-wiki " +
      "pages. mode='hybrid' (default) reciprocal-rank-fuses BGE-M3 semantic " +
      "search and trigram keyword search. Optionally filter docs by " +
      "source_types; set include_wiki=false to skip wiki pages (default on). " +
      "Returns top-k chunks with citations; a hit's `kind` is 'document' or " +
      "'wiki' (wiki hits carry `slug`/`article_id` and a knowledge_article " +
      "citation — prefer reading the synthesised page).",
    inputSchema: SearchKnowledgeIn,
    outputSchema: SearchKnowledgeOut,
    annotations: { readOnly: true },

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

      const includeWiki = parsed.include_wiki;
      const rows = await withUserContext(pool, ctx.userEntraId, async (client) => {
        const EMPTY_DENSE: Promise<RawWikiRow[]> = Promise.resolve([]);
        switch (mode) {
          case "dense": {
            if (!embedding) throw new Error("dense search requires an embedding");
            const [dense, wiki] = await Promise.all([
              denseSearch(client, embedding, k, sourceTypes),
              includeWiki ? denseWikiSearch(client, embedding, k) : EMPTY_DENSE,
            ]);
            const scored: Array<AnyRow & { score: number }> = [
              ...dense.map((r) => ({ ...r, score: 1 - (r.distance ?? 0) })),
              ...wiki.map((r) => ({ ...r, score: 1 - (r.distance ?? 0) })),
            ];
            scored.sort((a, b) => b.score - a.score);
            return scored.slice(0, k);
          }
          case "sparse": {
            const [sparse, wiki] = await Promise.all([
              sparseSearch(client, query, k, sourceTypes),
              includeWiki ? sparseWikiSearch(client, query, k) : EMPTY_DENSE,
            ]);
            const scored: Array<AnyRow & { score: number }> = [
              ...sparse.map((r) => ({ ...r, score: r.trgm_sim ?? 0 })),
              ...wiki.map((r) => ({ ...r, score: r.trgm_sim ?? 0 })),
            ];
            scored.sort((a, b) => b.score - a.score);
            return scored.slice(0, k);
          }
          default: {
            if (!embedding) throw new Error("hybrid search requires an embedding");
            const [dense, sparse, denseWiki, sparseWiki] = await Promise.all([
              denseSearch(client, embedding, k * 2, sourceTypes),
              sparseSearch(client, query, k * 2, sourceTypes),
              includeWiki ? denseWikiSearch(client, embedding, k * 2) : EMPTY_DENSE,
              includeWiki ? sparseWikiSearch(client, query, k * 2) : EMPTY_DENSE,
            ]);
            return reciprocalRankFusion([dense, sparse, denseWiki, sparseWiki], _RRF_K, k);
          }
        }
      });

      const hits = rows.map((r) => {
        const score = (r as { score: number }).score;
        if (isWikiRow(r)) {
          return {
            kind: "wiki" as const,
            chunk_id: r.chunk_id,
            document_id: null,
            article_id: r.article_id,
            slug: r.slug,
            heading_path: r.heading_path,
            text: r.text,
            source_type: r.article_kind,
            document_title: r.article_title,
            score,
            citation: {
              source_id: r.chunk_id,
              source_kind: "knowledge_article" as const,
              source_uri: r.slug,
              snippet: r.text.slice(0, 500),
            } satisfies Citation,
          };
        }
        return {
          kind: "document" as const,
          chunk_id: r.chunk_id,
          document_id: r.document_id,
          article_id: null,
          slug: null,
          heading_path: r.heading_path,
          text: r.text,
          source_type: r.source_type,
          document_title: r.document_title,
          score,
          citation: {
            source_id: r.chunk_id,
            source_kind: "document_chunk" as const,
            source_uri: r.original_uri ?? r.chunk_id,
            snippet: r.text.slice(0, 500),
          } satisfies Citation,
        };
      });

      return SearchKnowledgeOut.parse({ mode, hits });
    },
  });
}
