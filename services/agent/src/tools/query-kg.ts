// Tool: query_kg
//
// Typed passthrough to mcp-kg's query_at_time. The agent supplies an
// entity reference, optional predicate filter, optional bi-temporal
// snapshot, and we return the matching facts with provenance.
//
// Why a separate tool (as opposed to extending search_knowledge):
// query_kg is the KG-as-structured-memory access path. search_knowledge
// is text retrieval. Keeping them distinct lets the model reason about
// which to call — structure vs. prose — rather than overloading a single
// tool.

import { z } from "zod";

import type { McpKgClient, QueryAtTimeInput, QueryAtTimeOutput } from "../mcp-clients.js";

const EntityRef = z.object({
  label: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Z][A-Za-z0-9_]*$/),
  id_property: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/),
  id_value: z.string().min(1).max(4000),
});

const Predicate = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Z][A-Z0-9_]*$/);

export const QueryKgInput = z.object({
  entity: EntityRef,
  predicate: Predicate.optional(),
  direction: z.enum(["in", "out", "both"]).default("both"),
  /**
   * ISO-8601 aware datetime. If omitted, the query returns facts valid
   * "now". Use this to ask e.g. "what was the believed yield at the time
   * the Phase 1 decision was made?".
   */
  at_time: z.string().datetime({ offset: true }).optional(),
  include_invalidated: z.boolean().default(false),
});
export type QueryKgInput = z.infer<typeof QueryKgInput>;

// The output schema mirrors the upstream mcp-kg QueryAtTimeOutput shape
// verbatim — re-declared here so we don't couple the tool contract to a
// client-internal type.
export const QueryKgOutput = z.object({
  facts: z.array(
    z.object({
      fact_id: z.string().uuid(),
      subject: EntityRef,
      predicate: Predicate,
      object: EntityRef,
      edge_properties: z.record(z.unknown()),
      confidence_tier: z.enum([
        "expert_validated",
        "multi_source_llm",
        "single_source_llm",
        "expert_disputed",
        "invalidated",
      ]),
      confidence_score: z.number(),
      t_valid_from: z.string(),
      t_valid_to: z.string().nullable(),
      recorded_at: z.string(),
      provenance: z.object({
        source_type: z.string(),
        source_id: z.string(),
      }).passthrough(),
    }),
  ),
});
export type QueryKgOutput = z.infer<typeof QueryKgOutput>;

export interface QueryKgDeps {
  kg: McpKgClient;
}

export async function queryKg(
  input: QueryKgInput,
  deps: QueryKgDeps,
): Promise<QueryKgOutput> {
  const parsed = QueryKgInput.parse(input);
  const res = await deps.kg.queryAtTime(parsed as QueryAtTimeInput);
  // Pass through QueryAtTimeOutput unchanged (we keep the shapes in sync).
  return QueryKgOutput.parse(res as QueryAtTimeOutput);
}
