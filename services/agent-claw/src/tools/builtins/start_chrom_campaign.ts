// start_chrom_campaign — create an optimization_campaigns row for an
// HPLC method-optimization campaign.
//
// Phase Z6 closed-loop chromatography primitive. Builds the BoFire Domain
// via mcp_chrom_method_optimizer /build_domain (chromatography-aware sugar
// over column descriptors + gradient scheme + monotonicity constraints),
// persists the canonical Domain JSON in optimization_campaigns, returns
// the campaign_id for subsequent recommend_next_chrom_batch calls.
//
// Mirrors start_optimization_campaign one-for-one — the chromatography
// knowledge is on the MCP side, not in this builtin.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";
import { normalizeUrl } from "../../mcp/normalize-url.js";

const TANAKA_VECTOR = z.tuple([
  z.number(), z.number(), z.number(),
  z.number(), z.number(), z.number(),
]);

export const StartChromCampaignIn = z.object({
  campaign_name: z.string().min(1).max(200),
  // Required: campaigns must be project-scoped so RLS can confine them to
  // members of that project. Unscoped (NULL) campaigns are not supported.
  nce_project_internal_id: z.string().min(1).max(200),
  gradient_scheme: z
    .enum(["linear", "hold_ramp_hold", "multi_segment"])
    .default("hold_ramp_hold"),
  // Number of intermediate breakpoints for the multi_segment scheme
  // (ignored for linear / hold_ramp_hold).
  n_segments: z.number().int().min(1).max(5).default(3),
  // Each entry pairs a column id (string used as the categorical level)
  // with its Tanaka 6-vector. The agent typically sources these from
  // query_chrom_columns and forwards them verbatim.
  columns: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        tanaka: TANAKA_VECTOR,
      }),
    )
    .min(1)
    .max(50),
  // Used only in binary eluent mode; safe default lets ternary callers omit it.
  b_solvent_choices: z.array(z.string().min(1).max(50)).max(10).default(["MeCN", "MeOH"]),
  additive_choices: z.array(z.string().min(1).max(50)).min(1).max(10),
  flow_bounds_mLmin: z.tuple([z.number(), z.number()]).default([0.2, 1.0]),
  T_bounds_C: z.tuple([z.number(), z.number()]).default([25.0, 55.0]),
  objective_mode: z.enum(["single", "pareto"]).default("single"),
  // binary: B = a chosen organic (b_solvent_choices). ternary: B-channel is
  // a continuous MeCN/MeOH mix (b_meoh_fraction); b_solvent categorical dropped.
  eluent_mode: z.enum(["binary", "ternary"]).default("binary"),
});
export type StartChromCampaignInput = z.infer<typeof StartChromCampaignIn>;

export const StartChromCampaignOut = z.object({
  campaign_id: z.string().uuid(),
  campaign_name: z.string(),
  status: z.string(),
  n_inputs: z.number().int(),
  n_outputs: z.number().int(),
  gradient_scheme: z.string(),
  objective_mode: z.string(),
  eluent_mode: z.string(),
  n_segments: z.number().int(),
});
export type StartChromCampaignOutput = z.infer<typeof StartChromCampaignOut>;

const BuildDomainOut = z.object({
  bofire_domain: z.record(z.unknown()),
  n_inputs: z.number().int(),
  n_outputs: z.number().int(),
  gradient_scheme: z.string(),
  objective_mode: z.string(),
  eluent_mode: z.string(),
  n_segments: z.number().int(),
});

const TIMEOUT_MS = 30_000;

export function buildStartChromCampaignTool(pool: Pool, optimizerUrl: string) {
  const base = normalizeUrl(optimizerUrl);
  return defineTool({
    id: "start_chrom_campaign",
    description:
      "Create a closed-loop chromatography-method-optimization campaign. " +
      "Validates the column / eluent / gradient factor space via BoFire " +
      "(column choice encoded as a CategoricalDescriptorInput with Tanaka " +
      "6-axis selectivity descriptors). Persists the canonical BoFire Domain " +
      "in optimization_campaigns. Returns campaign_id for the first " +
      "recommend_next_chrom_batch call.",
    inputSchema: StartChromCampaignIn,
    outputSchema: StartChromCampaignOut,
    annotations: { readOnly: false },

    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) {
        throw new Error("start_chrom_campaign requires userEntraId in context");
      }

      const column_choices = input.columns.map((c) => c.id);
      const column_descriptors = input.columns.map((c) => c.tanaka);

      // 1. Build Domain via the chromatography MCP.
      const domain = await postJson(
        `${base}/build_domain`,
        {
          gradient_scheme: input.gradient_scheme,
          n_segments: input.n_segments,
          column_choices,
          column_descriptors,
          b_solvent_choices: input.b_solvent_choices,
          additive_choices: input.additive_choices,
          flow_bounds_mLmin: input.flow_bounds_mLmin,
          T_bounds_C: input.T_bounds_C,
          objective_mode: input.objective_mode,
          eluent_mode: input.eluent_mode,
        },
        BuildDomainOut,
        TIMEOUT_MS,
        "mcp-chrom-method-optimizer",
      );

      // 2. Persist (RLS-scoped insert).
      const campaign_type =
        input.objective_mode === "pareto" ? "multi_objective" : "single_objective";
      const strategy =
        input.objective_mode === "pareto" ? "MoboStrategy" : "SoboStrategy";
      const acquisition =
        input.objective_mode === "pareto" ? "qNEHVI" : "qLogEI";

      const campaign = await withUserContext(pool, userEntraId, async (client) => {
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
            campaign_type,
            strategy,
            acquisition,
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

      return StartChromCampaignOut.parse({
        campaign_id: campaign.id,
        campaign_name: campaign.campaign_name,
        status: campaign.status,
        n_inputs: domain.n_inputs,
        n_outputs: domain.n_outputs,
        gradient_scheme: domain.gradient_scheme,
        objective_mode: domain.objective_mode,
        eluent_mode: domain.eluent_mode,
        n_segments: domain.n_segments,
      });
    },
  });
}
