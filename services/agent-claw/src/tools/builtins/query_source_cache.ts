// query_source_cache — Tranche 5 / M1 builtin.
//
// The source-cache hook (services/agent-claw/src/core/hooks/source-cache.ts)
// writes :SourceEntity → :LiteralFact edges to the KG every time the agent
// invokes a query_eln_* / fetch_eln_* / fetch_instrument_* tool, with a
// 7-day TTL on `valid_until`. The audit found that nothing read those
// cached facts back — the cache infrastructure was built but never used.
//
// This tool closes the loop: given a (source_system_id, subject_id) pair —
// the same composite key the hook indexes by — it returns matching cached
// facts. The v3 system prompt routes the agent here BEFORE re-invoking
// the source-system tool, so a second call within the TTL window
// short-circuits the network round-trip.
//
// Returns whatever query_at_time returns; callers inspect
// `edge_properties.valid_until` to decide whether to trust the cached
// value or re-fetch.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";

// ---------- Schemas ----------------------------------------------------------

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

export const QuerySourceCacheIn = z.object({
  source_system_id: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Opaque label of the source system the cache is keyed by " +
        "(e.g. 'eln_local', 'logs_sciy'). Same value the source-cache hook " +
        "stamps onto the :SourceEntity node.",
    ),
  subject_id: z
    .string()
    .min(1)
    .max(4_000)
    .describe(
      "External id of the subject within the source system " +
        "(e.g. 'EXP-007', 'SAMPLE-42'). Same value the source-cache hook " +
        "stamps onto :SourceEntity.external_id.",
    ),
  predicate: Predicate.optional().describe(
    "Optional predicate filter (e.g. 'HAS_YIELD'). Omit to return every " +
      "cached fact for the subject.",
  ),
  group_id: GroupId.optional(),
  freshness_window_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe(
      "Filter out facts whose `valid_until` is older than NOW() - N days. " +
        "Without this filter the agent must inspect each fact's " +
        "edge_properties.valid_until itself; the server-side filter prevents " +
        "stale-cache reuse by oversight.",
    ),
});
export type QuerySourceCacheInput = z.infer<typeof QuerySourceCacheIn>;

const EntityRef = z.object({
  label: z.string(),
  id_property: z.string(),
  id_value: z.string(),
});

const FactSchema = z.object({
  fact_id: z.string().uuid(),
  subject: EntityRef,
  predicate: z.string(),
  object: EntityRef,
  edge_properties: z.record(z.unknown()),
  confidence_tier: z.string(),
  confidence_score: z.number(),
  t_valid_from: z.string(),
  t_valid_to: z.string().nullable(),
  recorded_at: z.string(),
  provenance: z.record(z.unknown()),
});

export const QuerySourceCacheOut = z.object({
  facts: z.array(FactSchema),
  /**
   * Echo of the SourceEntity composite key the tool used to look up the
   * cache. Useful for the agent to confirm it queried what it intended.
   */
  source_entity_id: z.string(),
});
export type QuerySourceCacheOutput = z.infer<typeof QuerySourceCacheOut>;

const TIMEOUT_MS = 10_000;

// ---------- Factory ----------------------------------------------------------

export function buildQuerySourceCacheTool(mcpKgUrl: string) {
  const base = mcpKgUrl.replace(/\/$/, "");
  return defineTool({
    id: "query_source_cache",
    description:
      "Check the KG for cached facts about a source-system subject before " +
      "re-invoking the source. Hits the same :SourceEntity → :LiteralFact " +
      "edges the source-cache hook writes. Returns matching facts with " +
      "edge_properties.valid_until — re-fetch from the source if expired.",
    inputSchema: QuerySourceCacheIn,
    outputSchema: QuerySourceCacheOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      // The source-cache projector keys :SourceEntity by
      // `${source_system_id}:${subject_id}` under the `source_entity_id`
      // property; mirror that here.
      const sourceEntityId = `${input.source_system_id}:${input.subject_id}`;
      const body = {
        entity: {
          label: "SourceEntity",
          id_property: "source_entity_id",
          id_value: sourceEntityId,
        },
        predicate: input.predicate,
        direction: "out" as const,
        include_invalidated: false,
        ...(input.group_id !== undefined ? { group_id: input.group_id } : {}),
      };
      const result = await postJson(
        `${base}/tools/query_at_time`,
        body,
        z.object({ facts: z.array(FactSchema) }),
        TIMEOUT_MS,
        "mcp-kg",
      );
      // Server-side filter: drop facts whose valid_until is older than
      // NOW() - freshness_window_days. valid_until lives on edge_properties
      // as an ISO 8601 timestamp string per the source-cache hook's contract.
      let facts = result.facts;
      if (input.freshness_window_days !== undefined) {
        const cutoff = Date.now() - input.freshness_window_days * 86_400_000;
        facts = facts.filter((f) => {
          const validUntil = f.edge_properties.valid_until;
          if (typeof validUntil !== "string") return true; // no TTL → keep
          const ts = Date.parse(validUntil);
          return Number.isFinite(ts) && ts >= cutoff;
        });
      }
      return QuerySourceCacheOut.parse({
        facts,
        source_entity_id: sourceEntityId,
      });
    },
  });
}
