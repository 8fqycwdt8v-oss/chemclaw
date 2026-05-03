// start_optimization_campaign — create an optimization_campaigns row.
//
// Z5 closed-loop primitive. Builds the BoFire Domain via mcp_reaction_optimizer
// /build_domain, persists the canonical Domain JSON in the optimization_campaigns
// row, returns the campaign_id for subsequent recommend_next_batch calls.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";

const ContinuousFactor = z.object({
  name: z.string().min(1).max(64),
  type: z.literal("continuous"),
  range: z.tuple([z.number(), z.number()]),
});

const CategoricalInputSpec = z.object({
  name: z.string().min(1).max(64),
  values: z.array(z.string().min(1).max(200)).min(1).max(200),
});

const OutputSpec = z.object({
  name: z.string().min(1).max(64),
  direction: z.enum(["maximize", "minimize"]).default("maximize"),
});

export const StartOptimizationCampaignIn = z.object({
  campaign_name: z.string().min(1).max(200),
  // Required: campaigns must be project-scoped so RLS can confine them to
  // members of that project. Unscoped (NULL) campaigns are not supported.
  nce_project_internal_id: z.string().min(1).max(200),
  factors: z.array(ContinuousFactor).max(20).default([]),
  categorical_inputs: z.array(CategoricalInputSpec).max(20).default([]),
  outputs: z.array(OutputSpec).min(1).max(10),
  campaign_type: z.enum(["single_objective", "multi_objective"]).default("single_objective"),
  strategy: z
    .enum(["SoboStrategy", "MoboStrategy", "RandomStrategy", "QnehviStrategy"])
    .default("SoboStrategy"),
  acquisition: z
    .enum(["qLogEI", "qLogNEI", "qNEHVI", "qEHVI", "random"])
    .default("qLogEI"),
});
export type StartOptimizationCampaignInput = z.infer<typeof StartOptimizationCampaignIn>;

export const StartOptimizationCampaignOut = z.object({
  campaign_id: z.string().uuid(),
  campaign_name: z.string(),
  status: z.string(),
  n_inputs: z.number().int(),
  n_outputs: z.number().int(),
});
export type StartOptimizationCampaignOutput = z.infer<typeof StartOptimizationCampaignOut>;

const BuildDomainOut = z.object({
  bofire_domain: z.record(z.unknown()),
  n_inputs: z.number().int(),
  n_outputs: z.number().int(),
});

const TIMEOUT_MS = 30_000;

export function buildStartOptimizationCampaignTool(
  pool: Pool,
  optimizerUrl: string,
) {
  const base = optimizerUrl.replace(/\/$/, "");
  return defineTool({
    id: "start_optimization_campaign",
    description:
      "Create a closed-loop optimization campaign. Validates the factor space " +
      "via BoFire, persists the canonical Domain JSON in optimization_campaigns, " +
      "returns the campaign_id. Use recommend_next_batch with the returned id to " +
      "get the first batch of conditions to run.",
    inputSchema: StartOptimizationCampaignIn,
    outputSchema: StartOptimizationCampaignOut,
    annotations: { readOnly: false },

    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) {
        throw new Error("start_optimization_campaign requires userEntraId in context");
      }

      // 1. Validate + build Domain via the MCP.
      const domain = await postJson(
        `${base}/build_domain`,
        {
          factors: input.factors,
          categorical_inputs: input.categorical_inputs,
          outputs: input.outputs,
        },
        BuildDomainOut,
        TIMEOUT_MS,
        "mcp-reaction-optimizer",
      );

      // 2. Persist (RLS-scoped insert).
      const campaign = await withUserContext(pool, userEntraId, async (client) => {
        // Resolve project under RLS: a missing or RLS-filtered hit must throw,
        // not silently fall through to NULL (which would create an orphan row
        // and — pre-Z-review fix — would have been visible to all users).
        const proj = await client.query<{ id: string }>(
          `SELECT id::text FROM nce_projects WHERE internal_id = $1`,
          [input.nce_project_internal_id],
        );
        const nceProjectId = proj.rows[0]?.id;
        if (nceProjectId === undefined) {
          throw new Error("nce_project_not_found_or_forbidden");
        }
        const result = await client.query<{
          id: string;
          campaign_name: string;
          status: string;
        }>(
          `INSERT INTO optimization_campaigns
             (nce_project_id, campaign_name, campaign_type, strategy, acquisition,
              bofire_domain, created_by_user_entra_id)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
           RETURNING id::text, campaign_name, status`,
          [
            nceProjectId,
            input.campaign_name,
            input.campaign_type,
            input.strategy,
            input.acquisition,
            JSON.stringify(domain.bofire_domain),
            userEntraId,
          ],
        );
        const row = result.rows[0];
        if (!row) {
          throw new Error("campaign insert returned no row");
        }
        return row;
      });

      return StartOptimizationCampaignOut.parse({
        campaign_id: campaign.id,
        campaign_name: campaign.campaign_name,
        status: campaign.status,
        n_inputs: domain.n_inputs,
        n_outputs: domain.n_outputs,
      });
    },
  });
}
