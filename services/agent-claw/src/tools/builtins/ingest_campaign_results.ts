// ingest_campaign_results — record measured outcomes for a round.
//
// The chemist runs the proposed batch, measures yields, hands the results back
// to the agent. This builtin updates optimization_rounds.measured_outcomes
// (RLS-scoped) so the next recommend_next_batch call benefits from them.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";

const Outcome = z.object({
  factor_values: z.record(z.unknown()),
  outputs: z.record(z.number()),
});

export const IngestCampaignResultsIn = z.object({
  round_id: z.string().uuid(),
  measured_outcomes: z.array(Outcome).min(1).max(2000),
});
export type IngestCampaignResultsInput = z.infer<typeof IngestCampaignResultsIn>;

export const IngestCampaignResultsOut = z.object({
  round_id: z.string().uuid(),
  campaign_id: z.string().uuid(),
  n_outcomes: z.number().int(),
  ingested_at: z.string(),
});
export type IngestCampaignResultsOutput = z.infer<typeof IngestCampaignResultsOut>;

interface UpdatedRow {
  campaign_id: string;
  ingested_results_at: string;
}

export function buildIngestCampaignResultsTool(pool: Pool) {
  return defineTool({
    id: "ingest_campaign_results",
    description:
      "Record measured outcomes for a previously-proposed optimization round. " +
      "After this, the next recommend_next_batch call will incorporate these " +
      "observations into the BoFire Strategy.",
    inputSchema: IngestCampaignResultsIn,
    outputSchema: IngestCampaignResultsOut,
    annotations: { readOnly: false },

    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) {
        throw new Error("ingest_campaign_results requires userEntraId in context");
      }

      const updated = await withUserContext(pool, userEntraId, async (client) => {
        // Idempotency guard: refuse to overwrite an already-ingested round.
        // Distinguishes "round absent / not visible to user" from "already ingested"
        // by re-checking existence on miss.
        const result = await client.query<UpdatedRow>(
          `UPDATE optimization_rounds
              SET measured_outcomes = $2::jsonb,
                  ingested_results_at = NOW()
            WHERE id = $1
              AND ingested_results_at IS NULL
            RETURNING campaign_id::text,
                      ingested_results_at::text`,
          [input.round_id, JSON.stringify(input.measured_outcomes)],
        );
        const row = result.rows[0];
        if (!row) {
          const exists = await client.query<{ ingested_results_at: string | null }>(
            `SELECT ingested_results_at FROM optimization_rounds WHERE id = $1`,
            [input.round_id],
          );
          if (exists.rows[0] === undefined) {
            throw new Error("round_not_found");
          }
          throw new Error("round_already_ingested");
        }
        return row;
      });

      return IngestCampaignResultsOut.parse({
        round_id: input.round_id,
        campaign_id: updated.campaign_id,
        n_outcomes: input.measured_outcomes.length,
        ingested_at: updated.ingested_results_at,
      });
    },
  });
}
