// expand_reaction_context — Phase B.2 builtin.
//
// Pulls reagents, conditions, outcomes, failures, citations, and optional
// predecessors for a single reaction. All reads RLS-scoped. Bounded cost:
// 1 SQL read + up to 4 KG queries. Every surfaced fact_id goes into
// surfaced_fact_ids — harvested by the anti-fabrication post_tool hook.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";
import { QueryKgIn, QueryKgOut } from "./query_kg.js";

// ---------- Schemas ----------------------------------------------------------

export const ExpandReactionContextIn = z.object({
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
export type ExpandReactionContextInput = z.infer<typeof ExpandReactionContextIn>;

export const ExpandReactionContextOut = z.object({
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
  /** Every fact_id surfaced — harvested by anti-fabrication hook. */
  surfaced_fact_ids: z.array(z.string().uuid()),
});
export type ExpandReactionContextOutput = z.infer<typeof ExpandReactionContextOut>;

// ---------- Timeout ----------------------------------------------------------

const TIMEOUT_KG_MS = 15_000;

// ---------- Factory ----------------------------------------------------------

export function buildExpandReactionContextTool(pool: Pool, mcpKgUrl: string) {
  const kgBase = mcpKgUrl.replace(/\/$/, "");

  return defineTool({
    id: "expand_reaction_context",
    description:
      "Expand a reaction with full context: reagents, conditions, outcomes, failures, citations, and optional predecessors. " +
      "include defaults to all except predecessors. " +
      "Returns surfaced_fact_ids for anti-fabrication tracking.",
    inputSchema: ExpandReactionContextIn,
    outputSchema: ExpandReactionContextOut,

    execute: async (ctx, input) => {
      const include = new Set(input.include);

      // 1. Core reaction row.
      const rows = await withUserContext(pool, ctx.userEntraId, async (client) => {
        const q = await client.query<Record<string, unknown>>(
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
          [input.reaction_id],
        );
        return q.rows;
      });

      const row = rows[0];
      if (!row) {
        throw new Error(`reaction ${input.reaction_id} not found or not accessible`);
      }

      const out: ExpandReactionContextOutput = {
        reaction: {
          reaction_id: row.reaction_id as string,
          rxn_smiles: row.rxn_smiles as string | null,
          rxno_class: row.rxno_class as string | null,
          experiment_id: row.experiment_id as string,
          project_internal_id: row.project_internal_id as string,
          yield_pct: row.yield_pct != null ? Number(row.yield_pct) : null,
          outcome_status: row.outcome_status as string | null,
        },
        surfaced_fact_ids: [],
      };

      // 2. Reagents.
      if (include.has("reagents")) {
        const reagents = await withUserContext(pool, ctx.userEntraId, async (client) => {
          const q = await client.query<Record<string, unknown>>(
            `SELECT ru.role, ru.smiles, ru.equivalents, ru.source_eln_entry_id
               FROM reagents_used ru
              WHERE ru.reaction_id = $1::uuid`,
            [input.reaction_id],
          );
          return q.rows;
        });
        out.reagents = reagents.map((r: Record<string, unknown>) => ({
          role: r.role as string | null,
          smiles: r.smiles as string | null,
          equivalents: r.equivalents != null ? Number(r.equivalents) : null,
          source_eln_entry_id: r.source_eln_entry_id as string | null,
        }));
      }

      // 3. Conditions.
      if (include.has("conditions")) {
        out.conditions = {
          temp_c: row.temp_c != null ? Number(row.temp_c) : null,
          time_min: row.time_min != null ? Number(row.time_min) : null,
          solvent: row.solvent as string | null,
        };
      }

      // 4. Outcomes via KG.
      if (include.has("outcomes")) {
        try {
          const kgInput = QueryKgIn.parse({
            entity: { label: "Reaction", id_property: "id", id_value: input.reaction_id },
            predicate: "HAS_OUTCOME",
            direction: "out",
            include_invalidated: false,
          });
          const kgOut = await postJson(
            `${kgBase}/tools/query_at_time`,
            kgInput,
            QueryKgOut,
            TIMEOUT_KG_MS,
            "mcp-kg",
          );
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

      // 5. Failures via KG.
      if (include.has("failures")) {
        try {
          const kgInput = QueryKgIn.parse({
            entity: { label: "Reaction", id_property: "id", id_value: input.reaction_id },
            predicate: "HAS_FAILURE",
            direction: "out",
            include_invalidated: false,
          });
          const kgOut = await postJson(
            `${kgBase}/tools/query_at_time`,
            kgInput,
            QueryKgOut,
            TIMEOUT_KG_MS,
            "mcp-kg",
          );
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

      // 6. Citations (MVP: empty; Phase 6 wires search_knowledge).
      if (include.has("citations")) {
        out.citations = [];
      }

      // 7. Predecessors (hop_limit=2 required).
      if (include.has("predecessors") && input.hop_limit === 2) {
        const preds = await withUserContext(pool, ctx.userEntraId, async (client) => {
          const q = await client.query<Record<string, unknown>>(
            `SELECT r2.id::text AS reaction_id,
                    'prior_step_in_same_synthetic_step' AS relationship
               FROM reactions r1
               JOIN experiments e1 ON e1.id = r1.experiment_id
               JOIN experiments e2 ON e2.synthetic_step_id = e1.synthetic_step_id
               JOIN reactions r2   ON r2.experiment_id = e2.id
              WHERE r1.id = $1::uuid
                AND e2.created_at < e1.created_at
              ORDER BY e2.created_at DESC
              LIMIT 5`,
            [input.reaction_id],
          );
          return q.rows;
        });
        out.predecessors = preds.map((p: Record<string, unknown>) => ({
          reaction_id: p.reaction_id as string,
          relationship: p.relationship as string,
        }));
      }

      return ExpandReactionContextOut.parse(out);
    },
  });
}
