// retrieve_related — Tranche 3 / H1 builtin.
//
// First hybrid KG+vector retrieval surface in the codebase. The audit
// finding was that search_knowledge fuses dense+sparse over document_chunks
// only, query_kg returns KG facts, and the agent had no way to get a single
// ranked result that combines both. This tool fixes the immediate gap for
// "given a text query AND an entity I already resolved, give me the top-N
// chunks + facts ranked together" and lays down the rrfMerge utility that
// future modes (compounds, reactions) plug into.
//
// Out of scope for Tranche 3, deferred to BACKLOG: full free-text →
// (compound | reaction | document | KG) retrieval. That requires entity
// resolution from arbitrary text strings and a query-classification layer
// that's worth its own scope.

import { z } from "zod";
import { defineTool } from "../tool.js";
import type { ToolContext } from "../../core/types.js";
import { rrfMerge } from "../../core/rrf.js";
import {
  SearchKnowledgeIn,
  type SearchKnowledgeInput,
  type SearchKnowledgeOutput,
} from "./search_knowledge.js";
import {
  QueryKgIn,
  type QueryKgInput,
  type QueryKgOutput,
} from "./query_kg.js";

/**
 * Structural dep type for the search_knowledge arm. We only need its execute
 * surface — typing the full {@link Tool} would couple us to the Zod
 * input/output generic asymmetry (defineTool infers `I` from the input-side
 * of the schema, which has optional fields where `z.infer` omits them).
 */
interface SearchKnowledgeArm {
  execute: (
    ctx: ToolContext,
    input: SearchKnowledgeInput,
  ) => Promise<SearchKnowledgeOutput>;
}

interface QueryKgArm {
  execute: (
    ctx: ToolContext,
    input: QueryKgInput,
  ) => Promise<QueryKgOutput>;
}

// ---------- Schemas ----------------------------------------------------------

const EntityRef = z.object({
  label: z.string().min(1).max(80).regex(/^[A-Z][A-Za-z0-9_]*$/),
  id_property: z.string().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/),
  id_value: z.string().min(1).max(4000),
});

export const RetrieveRelatedIn = z.object({
  query: z
    .string()
    .min(1)
    .max(4_000)
    .describe("Free-text query — drives the document-chunk arm via search_knowledge."),
  entity: EntityRef.optional().describe(
    "Optional KG entity reference. When supplied, the KG arm runs " +
      "query_kg(entity) and its facts are RRF-merged with the chunk hits.",
  ),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(15)
    .describe("Maximum number of merged items to return."),
  source_types: SearchKnowledgeIn.shape.source_types,
  group_id: QueryKgIn.shape.group_id,
});
export type RetrieveRelatedInput = z.infer<typeof RetrieveRelatedIn>;

// Discriminated-union item so the agent can switch on `kind` and the
// downstream tooling keeps the original payload shape unchanged.
const ChunkItem = z.object({
  kind: z.literal("chunk"),
  rrf_score: z.number(),
  ranks: z.array(z.number()),
  chunk: z.unknown(), // typed via SearchKnowledgeOut on the producer side
});
const FactItem = z.object({
  kind: z.literal("fact"),
  rrf_score: z.number(),
  ranks: z.array(z.number()),
  fact: z.unknown(),
});

export const RetrieveRelatedOut = z.object({
  items: z.array(z.union([ChunkItem, FactItem])),
  /** Echo of the per-arm result counts pre-fusion, useful for debugging. */
  arm_counts: z.object({
    chunks: z.number().int(),
    facts: z.number().int(),
  }),
});
export type RetrieveRelatedOutput = z.infer<typeof RetrieveRelatedOut>;

// ---------- Internal row union ----------------------------------------------

type RetrieveRow =
  | { kind: "chunk"; chunk_id: string; chunk: SearchKnowledgeOutput["hits"][number] }
  | { kind: "fact"; fact_id: string; fact: QueryKgOutput["facts"][number] };

function rowKey(row: RetrieveRow): string {
  return row.kind === "chunk" ? `chunk:${row.chunk_id}` : `fact:${row.fact_id}`;
}

// ---------- Factory ----------------------------------------------------------

/**
 * @param searchKnowledgeTool - already-constructed search_knowledge tool;
 *                              we call its execute() rather than re-doing the
 *                              dense+sparse query plumbing.
 * @param queryKgTool         - already-constructed query_kg tool.
 *
 * Both deps are passed in (rather than built fresh) so the same Pool /
 * Pino logger / mcp-token cache the rest of the harness uses are reused.
 */
export function buildRetrieveRelatedTool(
  searchKnowledgeTool: SearchKnowledgeArm,
  queryKgTool: QueryKgArm,
) {
  return defineTool({
    id: "retrieve_related",
    description:
      "Hybrid KG+vector retrieval. Runs search_knowledge over documents and " +
      "(optionally) query_kg over a known entity, then reciprocal-rank-fuses " +
      "the two ranked lists. Use when the user asks 'what do we know about X' " +
      "and you have both a free-text query AND an entity to seed the KG arm.",
    inputSchema: RetrieveRelatedIn,
    outputSchema: RetrieveRelatedOut,
    annotations: { readOnly: true },
    execute: async (ctx, input) => {
      const parsed = RetrieveRelatedIn.parse(input);
      // Each arm is asked for ~2× top_k so the RRF merge has room to
      // promote items that are mid-rank in one list but top-rank in the
      // other. Capped at 50 (search_knowledge's per-call max).
      const armK = Math.min(parsed.top_k * 2, 50);

      const chunkPromise = searchKnowledgeTool.execute(ctx, {
        query: parsed.query,
        k: armK,
        mode: "hybrid",
        source_types: parsed.source_types,
      });

      const factPromise: Promise<QueryKgOutput | null> = parsed.entity
        ? queryKgTool.execute(ctx, {
            entity: parsed.entity,
            direction: "both",
            include_invalidated: false,
            group_id: parsed.group_id,
          })
        : Promise.resolve(null);

      const [chunkResult, factResult] = await Promise.all([chunkPromise, factPromise]);

      const chunkRows: RetrieveRow[] = chunkResult.hits.map((c) => ({
        kind: "chunk" as const,
        chunk_id: c.chunk_id,
        chunk: c,
      }));
      const factRows: RetrieveRow[] = (factResult?.facts ?? []).map((f) => ({
        kind: "fact" as const,
        fact_id: f.fact_id,
        fact: f,
      }));

      const merged = rrfMerge([chunkRows, factRows], {
        key: rowKey,
        limit: parsed.top_k,
      });

      const items = merged.map((m) =>
        m.item.kind === "chunk"
          ? {
              kind: "chunk" as const,
              rrf_score: m.score,
              ranks: m.ranks,
              chunk: m.item.chunk,
            }
          : {
              kind: "fact" as const,
              rrf_score: m.score,
              ranks: m.ranks,
              fact: m.item.fact,
            },
      );

      return RetrieveRelatedOut.parse({
        items,
        arm_counts: { chunks: chunkRows.length, facts: factRows.length },
      });
    },
  });
}
