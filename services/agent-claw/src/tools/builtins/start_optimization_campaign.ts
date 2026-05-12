// start_optimization_campaign — create an optimization_campaigns row.
//
// Z5 closed-loop primitive. Builds the BoFire Domain via mcp_reaction_optimizer
// /build_domain, persists the canonical Domain JSON in the optimization_campaigns
// row, returns the campaign_id for subsequent recommend_next_batch calls.

import { randomInt } from "node:crypto";
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

// Linear inequality / equality over the continuous factors. Equal-length
// `features` and `coefficients`; the MCP rejects mismatches at build time.
const LinearConstraintSpec = z.object({
  type: z.enum(["<=", ">=", "=="]).default("<="),
  features: z.array(z.string().min(1).max(64)).min(1).max(20),
  coefficients: z.array(z.number()).min(1).max(20),
  rhs: z.number(),
});

// Optional per-output bounds for ingest-time validation. Output values
// outside [lo, hi] are rejected by ingest_campaign_results so a typo
// (10 vs 100, fraction vs %) doesn't silently corrupt the GP fit.
const OutputBoundSpec = z.object({
  name: z.string().min(1).max(64),
  lo: z.number(),
  hi: z.number(),
});

export const StartOptimizationCampaignIn = z.object({
  campaign_name: z.string().min(1).max(200),
  // Required: campaigns must be project-scoped so RLS can confine them to
  // members of that project. Unscoped (NULL) campaigns are not supported.
  nce_project_internal_id: z.string().min(1).max(200),
  // Optional: link to a synthesis_campaigns umbrella so the orchestrator can
  // ask "which campaign owns this BO run?" without scanning campaign_steps.
  synthesis_campaign_id: z.string().uuid().optional(),
  factors: z.array(ContinuousFactor).max(20).default([]),
  categorical_inputs: z.array(CategoricalInputSpec).max(20).default([]),
  outputs: z.array(OutputSpec).min(1).max(10),
  constraints: z.array(LinearConstraintSpec).max(20).default([]),
  output_bounds: z.array(OutputBoundSpec).max(10).default([]),
  campaign_type: z.enum(["single_objective", "multi_objective"]).default("single_objective"),
  strategy: z
    .enum(["SoboStrategy", "MoboStrategy", "RandomStrategy", "QnehviStrategy"])
    .default("SoboStrategy"),
  acquisition: z
    .enum(["qLogEI", "qLogNEI", "qNEHVI", "qEHVI", "random"])
    .default("qLogEI"),
  // Optional caller-supplied seed for reproducibility. When omitted, a fresh
  // random seed is drawn so two campaigns over the same Domain don't both
  // start with the identical cold-start plate.
  seed: z.number().int().optional(),
});
export type StartOptimizationCampaignInput = z.infer<typeof StartOptimizationCampaignIn>;

export const StartOptimizationCampaignOut = z.object({
  campaign_id: z.string().uuid(),
  campaign_name: z.string(),
  status: z.string(),
  n_inputs: z.number().int(),
  n_outputs: z.number().int(),
  n_constraints: z.number().int(),
  bofire_version: z.string(),
  seed: z.number().int(),
});
export type StartOptimizationCampaignOutput = z.infer<typeof StartOptimizationCampaignOut>;

const BuildDomainOut = z.object({
  bofire_domain: z.record(z.unknown()),
  n_inputs: z.number().int(),
  n_outputs: z.number().int(),
  n_constraints: z.number().int(),
  bofire_version: z.string(),
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
      "(plus optional linear constraints and per-output bounds) via BoFire, " +
      "persists the canonical Domain JSON in optimization_campaigns, returns the " +
      "campaign_id. Use recommend_next_batch with the returned id to get the first " +
      "batch of conditions to run.",
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
          constraints: input.constraints,
        },
        BuildDomainOut,
        TIMEOUT_MS,
        "mcp-reaction-optimizer",
      );

      // 2. Resolve seed. Use crypto.randomInt for an unbiased 31-bit value;
      // BoFire seeds are passed through to torch / numpy, both of which
      // accept any non-negative int that fits in int32.
      const seed = input.seed ?? randomInt(0, 2 ** 31);

      // 3. Reduce output_bounds[] → JSONB map keyed by output name.
      const outputBoundsMap: Record<string, { lo: number; hi: number }> = {};
      for (const ob of input.output_bounds ?? []) {
        if (ob.lo > ob.hi) {
          throw new Error(
            `output_bounds[${ob.name}]: lo (${ob.lo}) must be <= hi (${ob.hi})`,
          );
        }
        outputBoundsMap[ob.name] = { lo: ob.lo, hi: ob.hi };
      }

      // 4. Persist (RLS-scoped insert).
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

        // If a synthesis_campaign_id was supplied, validate it is visible
        // under RLS — same posture as the project lookup. Wrong-tenant /
        // missing umbrellas must fail loudly, not silently.
        if (input.synthesis_campaign_id !== undefined) {
          const sc = await client.query<{ id: string }>(
            `SELECT id::text FROM synthesis_campaigns
              WHERE id = $1::uuid AND nce_project_id = $2::uuid`,
            [input.synthesis_campaign_id, nceProjectId],
          );
          if (sc.rows[0] === undefined) {
            throw new Error("synthesis_campaign_not_found_or_forbidden");
          }
        }

        const result = await client.query<{
          id: string;
          campaign_name: string;
          status: string;
        }>(
          `INSERT INTO optimization_campaigns
             (nce_project_id, synthesis_campaign_id,
              campaign_name, campaign_type, strategy, acquisition,
              bofire_domain, bofire_version, constraints, output_bounds,
              seed, created_by_user_entra_id)
           VALUES ($1, $2, $3, $4, $5, $6,
                   $7::jsonb, $8, $9::jsonb, $10::jsonb,
                   $11, $12)
           RETURNING id::text, campaign_name, status`,
          [
            nceProjectId,
            input.synthesis_campaign_id ?? null,
            input.campaign_name,
            input.campaign_type,
            input.strategy,
            input.acquisition,
            JSON.stringify(domain.bofire_domain),
            domain.bofire_version,
            JSON.stringify(input.constraints),
            JSON.stringify(outputBoundsMap),
            seed,
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
        n_constraints: domain.n_constraints,
        bofire_version: domain.bofire_version,
        seed,
      });
    },
  });
}
