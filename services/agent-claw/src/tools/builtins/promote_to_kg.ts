// promote_to_kg — Universal Knowledge Accumulation Phase 0 builtin.
//
// The agent calls this when it wants a reasoning conclusion (or a piece of
// otherwise-unstructured knowledge) to enter the canonical fact store
// (`facts` table — db/init/62_facts_table.sql). Class is restricted to
// INTERPRETED / HYPOTHESIZED / ABSTRACTED — only the deterministic
// extractors and the source-cache hook are allowed to emit OBSERVED /
// COMPUTED.
//
// Confidence is capped per class to mirror the multiplicative-decay
// reliability ladder seeded in db/seed/09_universal_extraction_config.sql.
// The caps are hardcoded here rather than read from `config_settings`
// because (a) the agent must not be able to bump its own promotion ceiling
// at call time, and (b) the unit tests stay deterministic without a DB
// round-trip. When operators want to tighten promotion further, they can
// add a pre_tool hook that re-checks against `config_settings` — never
// loosen the bound below.
//
// Two writes inside one withUserContext transaction:
//   1. INSERT INTO facts (... extractor_name='promote_to_kg',
//                          source_table='agent_promotion',
//                          source_row_id=<user_entra_id>)
//   2. INSERT INTO ingestion_events (event_type='extracted_fact', ...)
//      — picked up by the (future) tool_result_extractor + kg_facts_sync
//      projectors per db/init/66_investigation_event_catalog.sql.
//
// Closest analog: services/agent-claw/src/tools/builtins/propose_hypothesis.ts
// (also writes a row + emits an ingestion event inside withUserContext).

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";

// ---------- Constants -------------------------------------------------------

const ALLOWED_CLASSES = ["INTERPRETED", "HYPOTHESIZED", "ABSTRACTED"] as const;
type AllowedClass = (typeof ALLOWED_CLASSES)[number];

// Per-class confidence caps. Mirror the multiplicative-decay reliability
// factors from db/seed/09_universal_extraction_config.sql but distinct
// values: a "cap" is the worst-case max an agent may promote at; a
// "decay factor" is the multiplier applied to the parent confidence as
// the class flows down the ladder. The cap prevents an agent from
// promoting a HYPOTHESIZED claim at 0.99 even when its self-reported
// confidence trends that high.
const CLASS_CAPS: Record<AllowedClass, number> = {
  INTERPRETED: 0.95,
  HYPOTHESIZED: 0.8,
  ABSTRACTED: 0.7,
};

// Tier derivation mirrors the existing 5-value tier vocabulary on `facts`
// (CHECK constraint: 'foundational' | 'high' | 'medium' | 'low' |
// 'exploratory'). Agent-promoted facts never land at 'foundational' (that
// tier is reserved for fully-validated artifacts), so the highest tier
// possible from this tool is 'high'.
function tierFromConfidence(c: number): string {
  if (c >= 0.85) return "high";
  if (c >= 0.65) return "medium";
  if (c >= 0.4) return "low";
  return "exploratory";
}

// ---------- Schemas ---------------------------------------------------------

export const PromoteToKgIn = z.object({
  subject_label: z
    .string()
    .min(1)
    .describe("Canonical entity label, e.g. 'Compound' / 'Reaction' / 'Project'."),
  subject_id_value: z
    .string()
    .min(1)
    .describe("Stable identifier for the subject (InChIKey, reaction UUID, …)."),
  predicate: z
    .string()
    .min(1)
    .describe("Relationship name, e.g. 'has_property' / 'reacts_with'."),
  object_label: z.string().optional(),
  object_id_value: z.string().optional(),
  object_value: z
    .unknown()
    .describe("Scalar or structured value for the object side of the triple."),
  unit: z.string().optional(),
  polarity: z.enum(["positive", "negative", "anomaly"]).default("positive"),
  derivation_class: z
    .enum(ALLOWED_CLASSES)
    .describe(
      "Restricted to INTERPRETED / HYPOTHESIZED / ABSTRACTED — OBSERVED " +
        "and COMPUTED are reserved for deterministic extractors / projectors.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Subject to per-class cap: INTERPRETED ≤0.95, HYPOTHESIZED ≤0.80, " +
        "ABSTRACTED ≤0.70.",
    ),
  source_fact_ids: z
    .array(z.string().uuid())
    .default([])
    .describe(
      "Parent fact UUIDs this claim derives from. Empty for terminal " +
        "leaf conclusions; non-empty bumps derivation_depth to 1.",
    ),
});
export type PromoteToKgInput = z.infer<typeof PromoteToKgIn>;

export const PromoteToKgOut = z.object({
  ok: z.literal(true),
  fact_id: z.string().uuid(),
  confidence_tier: z.enum(["high", "medium", "low", "exploratory"]),
});
export type PromoteToKgOutput = z.infer<typeof PromoteToKgOut>;

// ---------- Factory ---------------------------------------------------------

export function buildPromoteToKgTool(pool: Pool) {
  return defineTool({
    id: "promote_to_kg",
    description:
      "Promote an agent-derived conclusion to the canonical fact store. " +
      "Class is restricted to INTERPRETED / HYPOTHESIZED / ABSTRACTED. " +
      "Confidence is capped per class (INTERPRETED ≤0.95, HYPOTHESIZED " +
      "≤0.80, ABSTRACTED ≤0.70). Emits 'extracted_fact' ingestion event " +
      "for downstream projectors.",
    inputSchema: PromoteToKgIn,
    outputSchema: PromoteToKgOut,
    annotations: { readOnly: false },

    execute: async (ctx, input) => {
      const cap = CLASS_CAPS[input.derivation_class];
      if (input.confidence > cap) {
        throw new Error(
          `promote_to_kg rejected: confidence ${input.confidence} exceeds ` +
            `cap ${cap} for derivation_class=${input.derivation_class}. ` +
            `Tighten the conclusion or pick a more conservative class.`,
        );
      }

      const tier = tierFromConfidence(input.confidence);
      // .default([]) handles the omitted-key case at parse time. Belt-and-
      // suspenders for any direct execute() call path that bypassed
      // inputSchema.parse — never crash on a missing array.
      const sourceFactIds = input.source_fact_ids ?? [];
      const derivationDepth = sourceFactIds.length > 0 ? 1 : 0;

      return await withUserContext(pool, ctx.userEntraId, async (client) => {
        // INSERT INTO facts. project_id comes from ctx.nceProjectId so the
        // row participates in the same RLS visibility as the rest of the
        // user's project-scoped work. NULL project_id keeps the row org-
        // wide visible (matches the facts_project_visibility policy).
        const insert = await client.query<{ id: string }>(
          `INSERT INTO facts (
             project_id, subject_label, subject_id_value, predicate,
             object_label, object_id_value, object_value, unit,
             polarity, derivation_class, confidence, confidence_tier,
             source_table, source_row_id, source_fact_ids, extractor_name,
             derivation_depth
           ) VALUES (
             $1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8,
             $9, $10, $11, $12,
             'agent_promotion', $13, $14::uuid[], 'promote_to_kg', $15
           ) RETURNING id`,
          [
            ctx.nceProjectId,
            input.subject_label,
            input.subject_id_value,
            input.predicate,
            input.object_label ?? null,
            input.object_id_value ?? null,
            JSON.stringify(input.object_value ?? null),
            input.unit ?? null,
            input.polarity,
            input.derivation_class,
            input.confidence,
            tier,
            ctx.userEntraId,
            sourceFactIds,
            derivationDepth,
          ],
        );

        const row = insert.rows[0];
        if (!row) {
          throw new Error("promote_to_kg: INSERT INTO facts did not RETURN a row");
        }
        const factId = row.id;

        // Emit 'extracted_fact'. ingestion_events.source_row_id is a UUID;
        // facts.id is a UUID, so the cast is well-formed. Payload mirrors
        // db/init/66_investigation_event_catalog.sql — carries the fact_id
        // plus enough metadata for the extractor dispatcher to route.
        await client.query(
          `INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
           VALUES (
             'extracted_fact',
             'facts',
             $1::uuid,
             jsonb_build_object(
               'fact_id', $1::text,
               'extractor', 'promote_to_kg',
               'derivation_class', $2::text,
               'predicate', $3::text
             )
           )`,
          [factId, input.derivation_class, input.predicate],
        );

        return PromoteToKgOut.parse({
          ok: true as const,
          fact_id: factId,
          confidence_tier: tier,
        });
      });
    },
  });
}
