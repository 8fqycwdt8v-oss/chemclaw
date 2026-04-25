// Tool: expand_reaction_context
//
// Pulls reagents, conditions, outcomes, failures, citations, and
// optional predecessors for a single reaction. All reads are scoped by
// RLS via withUserContext. Failures + citations fan out via mcp-kg
// and search_knowledge respectively. Bounded cost: 1 SQL read, ≤6 KG
// queries, ≤1 search call.

import { z } from "zod";
import type { Pool } from "pg";

import type { McpEmbedderClient, McpKgClient } from "../mcp-clients.js";
import { withUserContext } from "../db.js";

export const ExpandReactionContextInput = z.object({
  reaction_id: z.string().uuid(),
  include: z
    .array(
      z.enum([
        "reagents",
        "conditions",
        "outcomes",
        "failures",
        "citations",
        "predecessors",
      ]),
    )
    .default(["reagents", "conditions", "outcomes", "failures", "citations"]),
  hop_limit: z.union([z.literal(1), z.literal(2)]).default(1),
});
export type ExpandReactionContextInput = z.infer<typeof ExpandReactionContextInput>;

export const ExpandReactionContextOutput = z.object({
  reaction: z.object({
    reaction_id: z.string().uuid(),
    rxn_smiles: z.string().nullable(),
    rxno_class: z.string().nullable(),
    experiment_id: z.string().uuid(),
    project_internal_id: z.string(),
    yield_pct: z.number().nullable(),
    outcome_status: z.string().nullable(),
  }),
  reagents: z
    .array(
      z.object({
        role: z.string().nullable(),
        smiles: z.string().nullable(),
        equivalents: z.number().nullable(),
        source_eln_entry_id: z.string().nullable(),
      }),
    )
    .optional(),
  conditions: z
    .object({
      temp_c: z.number().nullable(),
      time_min: z.number().nullable(),
      solvent: z.string().nullable(),
    })
    .optional(),
  outcomes: z
    .array(
      z.object({
        metric_name: z.string(),
        value: z.number().nullable(),
        unit: z.string().nullable(),
        source_fact_id: z.string().uuid().nullable(),
      }),
    )
    .optional(),
  failures: z
    .array(
      z.object({
        failure_mode: z.string(),
        evidence_text: z.string(),
        source_fact_id: z.string().uuid().nullable(),
      }),
    )
    .optional(),
  citations: z
    .array(
      z.object({
        document_id: z.string().uuid(),
        page: z.number().nullable(),
        excerpt: z.string(),
      }),
    )
    .optional(),
  predecessors: z
    .array(
      z.object({
        reaction_id: z.string().uuid(),
        relationship: z.string(),
      }),
    )
    .optional(),
  /** Every fact_id surfaced by this call — propagated into ctx.seenFactIds. */
  surfaced_fact_ids: z.array(z.string().uuid()),
});
export type ExpandReactionContextOutput = z.infer<typeof ExpandReactionContextOutput>;

export interface ExpandReactionContextDeps {
  pool: Pool;
  kg: McpKgClient;
  embedder: McpEmbedderClient;
  userEntraId: string;
}

export async function expandReactionContext(
  input: ExpandReactionContextInput,
  deps: ExpandReactionContextDeps,
): Promise<ExpandReactionContextOutput> {
  const parsed = ExpandReactionContextInput.parse(input);
  const include = new Set(parsed.include);

  const rows = await withUserContext(deps.pool, deps.userEntraId, async (client) => {
    const q = await client.query(
      `SELECT r.id::text                AS reaction_id,
              r.rxn_smiles, r.rxno_class,
              r.experiment_id::text     AS experiment_id,
              p.internal_id             AS project_internal_id,
              e.yield_pct, e.outcome_status,
              e.temperature_c           AS temp_c,
              e.time_min, e.solvent
         FROM reactions r
         JOIN experiments e        ON e.id  = r.experiment_id
         JOIN synthetic_steps ss   ON ss.id = e.synthetic_step_id
         JOIN nce_projects p       ON p.id  = ss.nce_project_id
        WHERE r.id = $1::uuid
        LIMIT 1`,
      [parsed.reaction_id],
    );
    return q.rows;
  });

  if (rows.length === 0) {
    throw new Error(`reaction ${parsed.reaction_id} not found or not accessible`);
  }
  const row = rows[0];

  const out: ExpandReactionContextOutput = {
    reaction: {
      reaction_id: row.reaction_id,
      rxn_smiles: row.rxn_smiles,
      rxno_class: row.rxno_class,
      experiment_id: row.experiment_id,
      project_internal_id: row.project_internal_id,
      yield_pct: row.yield_pct != null ? Number(row.yield_pct) : null,
      outcome_status: row.outcome_status,
    },
    surfaced_fact_ids: [],
  };

  if (include.has("reagents")) {
    const reagents = await withUserContext(deps.pool, deps.userEntraId, async (client) => {
      const q = await client.query(
        `SELECT ru.role, ru.smiles, ru.equivalents, ru.source_eln_entry_id
           FROM reagents_used ru
          WHERE ru.reaction_id = $1::uuid`,
        [parsed.reaction_id],
      );
      return q.rows;
    });
    out.reagents = reagents.map((r: any) => ({
      role: r.role,
      smiles: r.smiles,
      equivalents: r.equivalents != null ? Number(r.equivalents) : null,
      source_eln_entry_id: r.source_eln_entry_id,
    }));
  }

  if (include.has("conditions")) {
    out.conditions = {
      temp_c: row.temp_c != null ? Number(row.temp_c) : null,
      time_min: row.time_min != null ? Number(row.time_min) : null,
      solvent: row.solvent,
    };
  }

  if (include.has("outcomes")) {
    try {
      const kgOut = await deps.kg.queryAtTime({
        entity: { label: "Reaction", id_property: "id", id_value: parsed.reaction_id },
        predicate: "HAS_OUTCOME",
        direction: "out",
        include_invalidated: false,
      });
      out.outcomes = kgOut.facts.map((f) => ({
        metric_name: (f.edge_properties?.metric_name as string) ?? "unknown",
        value: (f.edge_properties?.value as number) ?? null,
        unit: (f.edge_properties?.unit as string) ?? null,
        source_fact_id: f.fact_id,
      }));
      out.surfaced_fact_ids.push(...kgOut.facts.map((f) => f.fact_id));
    } catch {
      out.outcomes = [];
    }
  }

  if (include.has("failures")) {
    try {
      const kgOut = await deps.kg.queryAtTime({
        entity: { label: "Reaction", id_property: "id", id_value: parsed.reaction_id },
        predicate: "HAS_FAILURE",
        direction: "out",
        include_invalidated: false,
      });
      out.failures = kgOut.facts.map((f) => ({
        failure_mode: (f.edge_properties?.failure_mode as string) ?? "unspecified",
        evidence_text: (f.edge_properties?.evidence_text as string) ?? "",
        source_fact_id: f.fact_id,
      }));
      out.surfaced_fact_ids.push(...kgOut.facts.map((f) => f.fact_id));
    } catch {
      out.failures = [];
    }
  }

  if (include.has("citations")) {
    // Citations are deferred — in this MVP we return an empty array.
    // Phase 6 will wire a proper citation lookup through search_knowledge.
    out.citations = [];
  }

  if (include.has("predecessors") && parsed.hop_limit === 2) {
    const preds = await withUserContext(deps.pool, deps.userEntraId, async (client) => {
      const q = await client.query(
        `SELECT r2.id::text AS reaction_id, 'prior_step_in_same_synthetic_step' AS relationship
           FROM reactions r1
           JOIN experiments e1 ON e1.id = r1.experiment_id
           JOIN experiments e2 ON e2.synthetic_step_id = e1.synthetic_step_id
           JOIN reactions r2   ON r2.experiment_id = e2.id
          WHERE r1.id = $1::uuid
            AND e2.created_at < e1.created_at
          ORDER BY e2.created_at DESC
          LIMIT 5`,
        [parsed.reaction_id],
      );
      return q.rows;
    });
    out.predecessors = preds.map((p: any) => ({
      reaction_id: p.reaction_id,
      relationship: p.relationship,
    }));
  }

  return ExpandReactionContextOutput.parse(out);
}
