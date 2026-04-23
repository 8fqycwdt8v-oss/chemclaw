// Tool: find_similar_reactions
//
// Given a seed reaction SMILES, encode it with DRFP via mcp-drfp, then
// cosine-search the pgvector `reactions.drfp_vector` column, scoped to the
// projects the calling user can see (RLS).
//
// This is the first concrete demonstration of the A-on-C retrieval pattern:
// the agent emits a domain query; the tool fetches via the derived view
// (pgvector) that was populated by the reaction-vectorizer projector from
// the Postgres event log. No bespoke data path.

import { z } from "zod";
import type { Pool } from "pg";

import type { McpDrfpClient } from "../mcp-clients.js";
import { withUserContext } from "../db.js";

// ---- Input / output schemas (exposed via Mastra tool registration) ---------

export const FindSimilarReactionsInput = z.object({
  rxn_smiles: z.string().min(3).max(20_000),
  k: z.number().int().min(1).max(50).default(10),
  // Optional filter: only reactions classified under this RXNO class.
  rxno_class: z.string().max(200).optional(),
  // Optional filter: yield gte some threshold (0..100).
  min_yield_pct: z.number().min(0).max(100).optional(),
});
export type FindSimilarReactionsInput = z.infer<typeof FindSimilarReactionsInput>;

export const SimilarReaction = z.object({
  reaction_id: z.string().uuid(),
  rxn_smiles: z.string().nullable(),
  rxno_class: z.string().nullable(),
  distance: z.number(), // cosine distance 0..2 (0 = identical direction)
  experiment_id: z.string().uuid(),
  eln_entry_id: z.string().nullable(),
  project_internal_id: z.string(),
  yield_pct: z.number().nullable(),
  outcome_status: z.string().nullable(),
});
export type SimilarReaction = z.infer<typeof SimilarReaction>;

export const FindSimilarReactionsOutput = z.object({
  seed_canonicalized: z.object({
    rxn_smiles: z.string(),
    on_bit_count: z.number().int().nonnegative(),
  }),
  results: z.array(SimilarReaction),
});
export type FindSimilarReactionsOutput = z.infer<typeof FindSimilarReactionsOutput>;

// ---- Execution -------------------------------------------------------------

export interface FindSimilarReactionsDeps {
  pool: Pool;
  drfp: McpDrfpClient;
  userEntraId: string;
}

/**
 * Build a pgvector vector literal `[0,1,0,...]` from a bit array.
 * Bounded in length by the caller-provided array (already validated).
 */
function toVectorLiteral(bits: number[]): string {
  // Use a single join with coercion-free output (0 or 1 only per schema).
  return "[" + bits.map((b) => (b ? "1" : "0")).join(",") + "]";
}

export async function findSimilarReactions(
  input: FindSimilarReactionsInput,
  deps: FindSimilarReactionsDeps,
): Promise<FindSimilarReactionsOutput> {
  const parsed = FindSimilarReactionsInput.parse(input);

  // 1. Encode the seed reaction.
  const encoded = await deps.drfp.computeDrfp({
    rxn_smiles: parsed.rxn_smiles,
    n_folded_length: 2048,
    radius: 3,
  });
  if (encoded.vector.length !== 2048) {
    throw new Error(`DRFP returned unexpected dim: ${encoded.vector.length}`);
  }

  // 2. Query pgvector within the user's RLS scope.
  const vectorLiteral = toVectorLiteral(encoded.vector);

  const rows = await withUserContext(deps.pool, deps.userEntraId, async (client) => {
    // Parameterised. Filters applied in SQL; RLS is enforced automatically
    // by the session variable set via withUserContext.
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
      parsed.rxno_class ?? null,
      parsed.min_yield_pct ?? null,
      parsed.k,
    ]);
    return q.rows;
  });

  return FindSimilarReactionsOutput.parse({
    seed_canonicalized: {
      rxn_smiles: parsed.rxn_smiles,
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
    })),
  });
}
