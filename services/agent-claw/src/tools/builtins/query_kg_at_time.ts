// query_kg_at_time — Tranche 4 / H3 builtin.
//
// Time-travel surface for the KG: returns the bi-temporal facts an entity
// had at a specific historical moment. Backed by the same mcp-kg
// /tools/query_at_time endpoint query_kg uses, but this tool REQUIRES the
// at_time parameter — making the temporal nature an explicit first-class
// action rather than an option the agent might forget to set.
//
// Bi-temporal correctness depends on Tranche 1 / C1 — every reader path
// filters by valid_to / invalidated. The time filter (`r.t_valid_from <=
// $at_time AND (r.t_valid_to IS NULL OR r.t_valid_to > $at_time)`) is
// applied server-side so the response is what the KG ACTUALLY KNEW on
// that date, not the current state.

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

const GroupId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);

export const QueryKgAtTimeIn = z.object({
  entity: EntityRef,
  /**
   * REQUIRED — that's the whole point of this tool. ISO-8601 datetime with
   * offset (e.g. "2025-12-01T00:00:00Z"). The KG returns facts that were
   * valid at this moment: t_valid_from ≤ at_time AND (t_valid_to IS NULL OR
   * t_valid_to > at_time).
   */
  at_time: z
    .string()
    .datetime({ offset: true })
    .describe(
      "ISO-8601 datetime with offset. The KG returns facts that were valid " +
        "at this moment. Required — use query_kg for current-state queries.",
    ),
  predicate: Predicate.optional(),
  direction: z.enum(["in", "out", "both"]).default("both"),
  /**
   * Whether to include facts that were invalidated AS OF the at_time
   * timestamp. Default false: invalidated facts are excluded even if the
   * invalidation happened after at_time. This is the more useful default
   * for "what did we believe on date X" — we want the snapshot the agent
   * would have seen.
   */
  include_invalidated: z.boolean().default(false),
  group_id: GroupId.optional(),
});
export type QueryKgAtTimeInput = z.infer<typeof QueryKgAtTimeIn>;

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
  provenance: z
    .object({
      source_type: z.string(),
      source_id: z.string(),
    })
    .passthrough(),
});

export const QueryKgAtTimeOut = z.object({
  facts: z.array(FactSchema),
});
export type QueryKgAtTimeOutput = z.infer<typeof QueryKgAtTimeOut>;

const TIMEOUT_MS = 20_000;

// ---------- Factory ----------------------------------------------------------

export function buildQueryKgAtTimeTool(mcpKgUrl: string) {
  const base = mcpKgUrl.replace(/\/$/, "");
  return defineTool({
    id: "query_kg_at_time",
    description:
      "Time-travel KG query: returns facts incident to an entity AS-OF a " +
      "specific historical moment. Use for 'what did we know on 2025-12-01' " +
      "/ replication / audit-style questions. For current state, use " +
      "query_kg instead — it's the same endpoint but with at_time omitted.",
    inputSchema: QueryKgAtTimeIn,
    outputSchema: QueryKgAtTimeOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      return await postJson(
        `${base}/tools/query_at_time`,
        input,
        QueryKgAtTimeOut,
        TIMEOUT_MS,
        "mcp-kg",
      );
    },
  });
}
