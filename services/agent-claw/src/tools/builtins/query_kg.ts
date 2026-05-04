// query_kg — Phase B.2 builtin.
//
// Typed passthrough to mcp-kg's query_at_time. Returns bi-temporal KG facts.
// Every returned fact_id is added to ctx.seenFactIds via the anti-fabrication
// hook (post_tool). The tool itself emits fact_ids in the output for the hook
// to harvest; it does NOT write to seenFactIds directly.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";

// ---------- Schemas ----------------------------------------------------------

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

// Tenant scope identifier. mcp-kg now requires every fact to carry a
// group_id; the server defaults this to "__system__" when the field is
// omitted, matching the Pydantic default. Production callers should pass
// the canonical project id so cross-tenant fact access stays gated by RLS.
const GroupId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_\-]+$/);

export const QueryKgIn = z.object({
  entity: EntityRef,
  predicate: Predicate.optional(),
  direction: z.enum(["in", "out", "both"]).default("both"),
  at_time: z.string().datetime({ offset: true }).optional(),
  include_invalidated: z.boolean().default(false),
  group_id: GroupId.optional(),
});
export type QueryKgInput = z.infer<typeof QueryKgIn>;

const FactSchema = z.object({
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
});

export const QueryKgOut = z.object({
  facts: z.array(FactSchema),
});
export type QueryKgOutput = z.infer<typeof QueryKgOut>;

// ---------- Timeout ----------------------------------------------------------

const TIMEOUT_MS = 20_000;

// ---------- Factory ----------------------------------------------------------

export function buildQueryKgTool(mcpKgUrl: string) {
  const base = mcpKgUrl.replace(/\/$/, "");

  return defineTool({
    id: "query_kg",
    description:
      "Query the bi-temporal knowledge graph for facts about an entity. " +
      "Use direction='out' for subject→predicate→object traversal. " +
      "Supply at_time (ISO-8601) for historical queries. " +
      "Returned fact_ids are tracked for anti-fabrication checks.",
    inputSchema: QueryKgIn,
    outputSchema: QueryKgOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      return await postJson(
        `${base}/tools/query_at_time`,
        input,
        QueryKgOut,
        TIMEOUT_MS,
        "mcp-kg",
      );
    },
  });
}
