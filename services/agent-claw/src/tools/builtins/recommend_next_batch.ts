// recommend_next_batch — propose the next round of experiments for a campaign.
//
// Reads the campaign's bofire_domain JSON + all measured outcomes from prior
// rounds (RLS-scoped), passes them to mcp_reaction_optimizer /recommend_next,
// inserts a new optimization_rounds row with the proposals, and returns it.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";

export const RecommendNextBatchIn = z.object({
  campaign_id: z.string().uuid(),
  n_candidates: z.number().int().min(1).max(200).default(8),
  seed: z.number().int().default(42),
});
export type RecommendNextBatchInput = z.infer<typeof RecommendNextBatchIn>;

const Proposal = z.object({
  factor_values: z.record(z.unknown()),
  source: z.string(),
});

export const RecommendNextBatchOut = z.object({
  campaign_id: z.string().uuid(),
  round_id: z.string().uuid(),
  round_index: z.number().int(),
  n_observations: z.number().int(),
  used_bo: z.boolean(),
  proposals: z.array(Proposal),
});
export type RecommendNextBatchOutput = z.infer<typeof RecommendNextBatchOut>;

const RecommendNextOut = z.object({
  proposals: z.array(Proposal),
  n_observations: z.number().int(),
  used_bo: z.boolean(),
});

const TIMEOUT_MS = 120_000;

interface CampaignRow {
  bofire_domain: unknown;
  status: string;
}

interface RoundRow {
  measured_outcomes: unknown;
  round_index: number;
}

export function buildRecommendNextBatchTool(pool: Pool, optimizerUrl: string) {
  const base = optimizerUrl.replace(/\/$/, "");
  return defineTool({
    id: "recommend_next_batch",
    description:
      "Propose the next batch of experiments for a closed-loop optimization " +
      "campaign. Pulls measured outcomes from prior rounds (RLS-scoped), fits " +
      "a BoFire Strategy, returns n_candidates next conditions. Cold-start " +
      "(< 3 observations) returns space-filling random samples.",
    inputSchema: RecommendNextBatchIn,
    outputSchema: RecommendNextBatchOut,
    annotations: { readOnly: false },

    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) {
        throw new Error("recommend_next_batch requires userEntraId in context");
      }

      const { domain, measured, nextIndex } = await withUserContext(
        pool,
        userEntraId,
        async (client) => {
          const camp = await client.query<CampaignRow>(
            `SELECT bofire_domain, status FROM optimization_campaigns WHERE id = $1`,
            [input.campaign_id],
          );
          const c = camp.rows[0];
          if (c === undefined) {
            throw new Error(`campaign_not_found: ${input.campaign_id}`);
          }
          if (c.status !== "active") {
            throw new Error(`campaign_not_active: status=${c.status}`);
          }
          const rounds = await client.query<RoundRow>(
            `SELECT measured_outcomes, round_index
               FROM optimization_rounds
              WHERE campaign_id = $1
              ORDER BY round_index ASC`,
            [input.campaign_id],
          );
          const allMeasured: unknown[] = [];
          for (const row of rounds.rows) {
            if (row.measured_outcomes !== null && Array.isArray(row.measured_outcomes)) {
              for (const item of row.measured_outcomes) {
                allMeasured.push(item);
              }
            }
          }
          const maxIdx = rounds.rows.reduce(
            (acc, r) => Math.max(acc, r.round_index),
            -1,
          );
          return {
            domain: c.bofire_domain,
            measured: allMeasured,
            nextIndex: maxIdx + 1,
          };
        },
      );

      const reco = await postJson(
        `${base}/recommend_next`,
        {
          bofire_domain: domain,
          measured_outcomes: measured,
          n_candidates: input.n_candidates,
          seed: input.seed,
        },
        RecommendNextOut,
        TIMEOUT_MS,
        "mcp-reaction-optimizer",
      );

      const round = await withUserContext(pool, userEntraId, async (client) => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO optimization_rounds
             (campaign_id, round_index, proposals)
           VALUES ($1, $2, $3::jsonb)
           RETURNING id::text`,
          [input.campaign_id, nextIndex, JSON.stringify(reco.proposals)],
        );
        const row = result.rows[0];
        if (!row) {
          throw new Error("round insert returned no row");
        }
        return row;
      });

      return RecommendNextBatchOut.parse({
        campaign_id: input.campaign_id,
        round_id: round.id,
        round_index: nextIndex,
        n_observations: reco.n_observations,
        used_bo: reco.used_bo,
        proposals: reco.proposals,
      });
    },
  });
}
