// extract_pareto_front — multi-objective Pareto extraction (Z6).
//
// Reads all measured outcomes from a campaign's rounds (RLS-scoped), passes
// them with the campaign's output directions to mcp_reaction_optimizer
// /extract_pareto, returns the non-dominated subset.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";

export const ExtractParetoFrontIn = z.object({
  campaign_id: z.string().uuid(),
});
export type ExtractParetoFrontInput = z.infer<typeof ExtractParetoFrontIn>;

const Outcome = z.object({
  factor_values: z.record(z.unknown()),
  outputs: z.record(z.number()),
});

export const ExtractParetoFrontOut = z.object({
  campaign_id: z.string().uuid(),
  pareto: z.array(Outcome),
  n_total: z.number().int(),
  n_pareto: z.number().int(),
  output_directions: z.record(z.string()),
});
export type ExtractParetoFrontOutput = z.infer<typeof ExtractParetoFrontOut>;

const McpOut = z.object({
  pareto: z.array(Outcome),
  n_total: z.number().int(),
  n_pareto: z.number().int(),
  output_directions: z.record(z.string()),
});

interface CampaignRow {
  bofire_domain: { outputs?: { features?: Array<{ key: string; objective?: { type?: string } }> } };
}

interface RoundRow {
  measured_outcomes: unknown;
}

const TIMEOUT_MS = 30_000;

export function buildExtractParetoFrontTool(pool: Pool, optimizerUrl: string) {
  const base = optimizerUrl.replace(/\/$/, "");
  return defineTool({
    id: "extract_pareto_front",
    description:
      "Compute the Pareto frontier (non-dominated set) of a campaign's measured " +
      "outcomes. Each output is treated per its declared direction " +
      "(maximize/minimize). Useful for surfacing the trade-off frontier in " +
      "multi-objective campaigns (yield × selectivity × PMI × greenness × safety).",
    inputSchema: ExtractParetoFrontIn,
    outputSchema: ExtractParetoFrontOut,
    annotations: { readOnly: true },

    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) {
        throw new Error("extract_pareto_front requires userEntraId in context");
      }

      const { measured, outputDirections } = await withUserContext(
        pool,
        userEntraId,
        async (client) => {
          const camp = await client.query<CampaignRow>(
            `SELECT bofire_domain FROM optimization_campaigns WHERE id = $1`,
            [input.campaign_id],
          );
          const c = camp.rows[0];
          if (c === undefined) {
            throw new Error(`campaign_not_found: ${input.campaign_id}`);
          }
          const features = c.bofire_domain.outputs?.features ?? [];
          const dirs: Record<string, string> = {};
          for (const f of features) {
            const objType = f.objective?.type ?? "";
            // BoFire serializes objectives as MaximizeObjective / MinimizeObjective
            // (or qualified subtypes). Inspect class name suffix.
            if (objType.startsWith("Min")) {
              dirs[f.key] = "minimize";
            } else {
              dirs[f.key] = "maximize";
            }
          }

          const rounds = await client.query<RoundRow>(
            `SELECT measured_outcomes FROM optimization_rounds
              WHERE campaign_id = $1 AND measured_outcomes IS NOT NULL`,
            [input.campaign_id],
          );
          const allMeasured: unknown[] = [];
          for (const row of rounds.rows) {
            if (Array.isArray(row.measured_outcomes)) {
              for (const item of row.measured_outcomes) {
                allMeasured.push(item);
              }
            }
          }
          return { measured: allMeasured, outputDirections: dirs };
        },
      );

      if (Object.keys(outputDirections).length === 0) {
        throw new Error("campaign has no output directions");
      }
      if (measured.length === 0) {
        return ExtractParetoFrontOut.parse({
          campaign_id: input.campaign_id,
          pareto: [],
          n_total: 0,
          n_pareto: 0,
          output_directions: outputDirections,
        });
      }

      const result = await postJson(
        `${base}/extract_pareto`,
        {
          measured_outcomes: measured,
          output_directions: outputDirections,
        },
        McpOut,
        TIMEOUT_MS,
        "mcp-reaction-optimizer",
      );

      return ExtractParetoFrontOut.parse({
        campaign_id: input.campaign_id,
        ...result,
      });
    },
  });
}
