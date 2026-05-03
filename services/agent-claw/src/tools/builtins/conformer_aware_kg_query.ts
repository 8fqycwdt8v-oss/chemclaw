// conformer_aware_kg_query — retrieve QM-anchored facts from the knowledge graph.
//
// Joins the Phase 1 qm_jobs / qm_conformers tables to the rest of the KG so
// the agent can answer "show me Pd-coupling reactions whose substrate has
// at least one conformer with a torsion in the 60-90° band". The full
// conformer-shape similarity (USR/USRCAT) lives behind a future projector;
// this builtin implements the simpler join paths today.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { withSystemContext } from "../../db/with-user-context.js";

export const ConformerAwareKgQueryIn = z.object({
  query: z.enum([
    "compounds_with_calculation",
    "lowest_conformer_energy",
    "calculation_history_for_compound",
  ]),
  inchikey: z.string().optional(),
  method: z.string().optional(),
  task: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(20),
});
export type ConformerAwareKgQueryInput = z.infer<typeof ConformerAwareKgQueryIn>;

export const ConformerAwareKgQueryOut = z.object({
  query: z.string(),
  rows: z.array(z.record(z.string(), z.unknown())),
});
export type ConformerAwareKgQueryOutput = z.infer<typeof ConformerAwareKgQueryOut>;

export function buildConformerAwareKgQueryTool(pool: Pool) {
  return defineTool({
    id: "conformer_aware_kg_query",
    description:
      "Retrieve QM-anchored facts from the KG. Queries: compounds_with_" +
      "calculation (filter by method/task), lowest_conformer_energy " +
      "(per inchikey), calculation_history_for_compound (audit trail of " +
      "QM jobs over time including bi-temporal valid_from/valid_to).",
    inputSchema: ConformerAwareKgQueryIn,
    outputSchema: ConformerAwareKgQueryOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      const limit = input.limit ?? 20;
      const rows = await withSystemContext(pool, async (client) => {
        switch (input.query) {
          case "compounds_with_calculation": {
            const r = await client.query<Record<string, unknown>>(
              `SELECT j.inchikey,
                      c.smiles_canonical,
                      j.method,
                      j.task,
                      r.energy_hartree,
                      r.converged,
                      j.recorded_at
                 FROM qm_jobs j
                 LEFT JOIN qm_results r ON r.job_id = j.id
                 LEFT JOIN compounds c ON c.inchikey = j.inchikey
                WHERE j.valid_to IS NULL
                  AND j.status = 'succeeded'
                  AND ($1::text IS NULL OR j.method = $1::text)
                  AND ($2::text IS NULL OR j.task = $2::text)
                ORDER BY j.recorded_at DESC
                LIMIT $3`,
              [input.method ?? null, input.task ?? null, limit],
            );
            return r.rows;
          }
          case "lowest_conformer_energy": {
            const r = await client.query<Record<string, unknown>>(
              `SELECT j.inchikey,
                      c.smiles_canonical,
                      MIN(qc.energy_hartree) AS lowest_energy_hartree,
                      COUNT(qc.id) AS n_conformers
                 FROM qm_conformers qc
                 JOIN qm_jobs j ON j.id = qc.job_id
                 LEFT JOIN compounds c ON c.inchikey = j.inchikey
                WHERE j.task IN ('conformers','tautomers','protomers')
                  AND ($1::text IS NULL OR j.inchikey = $1::text)
                GROUP BY j.inchikey, c.smiles_canonical
                ORDER BY lowest_energy_hartree
                LIMIT $2`,
              [input.inchikey ?? null, limit],
            );
            return r.rows;
          }
          case "calculation_history_for_compound": {
            if (!input.inchikey) {
              throw new Error("inchikey is required for calculation_history_for_compound");
            }
            const r = await client.query<Record<string, unknown>>(
              `SELECT j.id::text AS job_id,
                      j.method,
                      j.task,
                      j.solvent_model,
                      j.solvent_name,
                      j.status,
                      r.energy_hartree,
                      j.valid_from,
                      j.valid_to,
                      j.recorded_at
                 FROM qm_jobs j
                 LEFT JOIN qm_results r ON r.job_id = j.id
                WHERE j.inchikey = $1
                ORDER BY j.recorded_at DESC
                LIMIT $2`,
              [input.inchikey, limit],
            );
            return r.rows;
          }
        }
      });
      return { query: input.query, rows };
    },
  });
}
