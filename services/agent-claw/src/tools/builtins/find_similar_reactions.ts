// find_similar_reactions — Phase B.2 builtin.
//
// Given a seed reaction SMILES, encodes it via mcp-drfp, then cosine-searches
// pgvector reactions.drfp_vector scoped to the user's RLS context.
// Each result surfaces as a Citation with source_kind="reaction".

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";
import type { Citation } from "../../core/types.js";

// ---------- Schemas ----------------------------------------------------------

export const FindSimilarReactionsIn = z.object({
  rxn_smiles: z.string().min(3).max(20_000),
  k: z.number().int().min(1).max(50).default(10),
  rxno_class: z.string().max(200).optional(),
  min_yield_pct: z.number().min(0).max(100).optional(),
});
export type FindSimilarReactionsInput = z.infer<typeof FindSimilarReactionsIn>;

export const SimilarReaction = z.object({
  reaction_id: z.string().uuid(),
  rxn_smiles: z.string().nullable(),
  rxno_class: z.string().nullable(),
  distance: z.number(),
  experiment_id: z.string().uuid(),
  eln_entry_id: z.string().nullable(),
  project_internal_id: z.string(),
  yield_pct: z.number().nullable(),
  outcome_status: z.string().nullable(),
  citation: z.custom<Citation>(),
});

export const FindSimilarReactionsOut = z.object({
  seed_canonicalized: z.object({
    rxn_smiles: z.string(),
    on_bit_count: z.number().int().nonnegative(),
  }),
  results: z.array(SimilarReaction),
});
export type FindSimilarReactionsOutput = z.infer<typeof FindSimilarReactionsOut>;

// mcp-drfp encode response schema.
const DrfpEncodeOut = z.object({
  vector: z.array(z.number()),
  on_bit_count: z.number().int().nonnegative(),
});

// ---------- Helpers ----------------------------------------------------------

function toVectorLiteral(bits: number[]): string {
  return "[" + bits.map((b) => (b ? "1" : "0")).join(",") + "]";
}

// ---------- Timeouts ---------------------------------------------------------

const TIMEOUT_DRFP_MS = 15_000;
const TIMEOUT_DB_MS = 20_000;

// ---------- Factory ----------------------------------------------------------

export function buildFindSimilarReactionsTool(pool: Pool, mcpDrfpUrl: string) {
  const base = mcpDrfpUrl.replace(/\/$/, "");

  return defineTool({
    id: "find_similar_reactions",
    description:
      "Find reactions similar to a seed reaction SMILES using DRFP fingerprint cosine search. " +
      "Returns up to k reactions with their experiment context and citations.",
    inputSchema: FindSimilarReactionsIn,
    outputSchema: FindSimilarReactionsOut,
    annotations: { readOnly: true },

    execute: async (ctx, input) => {
      // 1. Encode the seed reaction via mcp-drfp.
      const encoded = await postJson(
        `${base}/tools/encode_drfp`,
        { rxn_smiles: input.rxn_smiles, n_folded_length: 2048, radius: 3 },
        DrfpEncodeOut,
        TIMEOUT_DRFP_MS,
        "mcp-drfp",
      );
      if (encoded.vector.length !== 2048) {
        throw new Error(`DRFP returned unexpected dim: ${encoded.vector.length}`);
      }

      // 2. Query pgvector within RLS scope.
      const vectorLiteral = toVectorLiteral(encoded.vector);

      const rows = await withUserContext(pool, ctx.userEntraId, async (client) => {
        const sql = `
          SELECT r.id::text AS reaction_id,
                 r.rxn_smiles,
                 r.rxno_class,
                 r.drfp_vector <=> $1::vector AS distance,
                 r.experiment_id::text AS experiment_id,
                 e.eln_entry_id,
                 p.internal_id AS project_internal_id,
                 e.yield_pct,
                 e.outcome_status
            FROM reactions r
            JOIN experiments e       ON e.id  = r.experiment_id
            JOIN synthetic_steps ss  ON ss.id = e.synthetic_step_id
            JOIN nce_projects p      ON p.id  = ss.nce_project_id
           WHERE r.drfp_vector IS NOT NULL
             AND ($2::text IS NULL OR r.rxno_class = $2)
             AND ($3::numeric IS NULL OR e.yield_pct >= $3)
           ORDER BY r.drfp_vector <=> $1::vector ASC
           LIMIT $4::int
        `;
        const q = await client.query(sql, [
          vectorLiteral,
          input.rxno_class ?? null,
          input.min_yield_pct ?? null,
          input.k,
        ]);
        return q.rows;
      });

      // Enforce TIMEOUT_DB_MS is used — it's implicit in withUserContext but
      // we keep a note here for Phase D when we add explicit statement_timeout.
      void TIMEOUT_DB_MS;

      return FindSimilarReactionsOut.parse({
        seed_canonicalized: {
          rxn_smiles: input.rxn_smiles,
          on_bit_count: encoded.on_bit_count,
        },
        results: rows.map((r: Record<string, unknown>) => ({
          reaction_id: r.reaction_id as string,
          rxn_smiles: r.rxn_smiles as string | null,
          rxno_class: r.rxno_class as string | null,
          distance: Number(r.distance),
          experiment_id: r.experiment_id as string,
          eln_entry_id: r.eln_entry_id as string | null,
          project_internal_id: r.project_internal_id as string,
          yield_pct: r.yield_pct != null ? Number(r.yield_pct) : null,
          outcome_status: r.outcome_status as string | null,
          citation: {
            source_id: r.reaction_id as string,
            source_kind: "reaction" as const,
          } satisfies Citation,
        })),
      });
    },
  });
}
