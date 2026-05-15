// extract_chrom_pareto_front — non-dominated set over a multi-objective
// chromatography campaign's measured outcomes.
//
// Reads every measured outcome from the campaign's rounds (RLS-scoped),
// hands them to mcp_chrom_method_optimizer /extract_pareto with the
// default chromatography objective directions (min_resolution → maximize,
// runtime_min → minimize, solvent_pmi_g → minimize), and returns the
// Pareto-optimal methods so the chemist can pick a trade-off. For a
// single-objective campaign (crf_total only) this just returns the best
// crf_total point; callers should prefer it on objective_mode='pareto'
// campaigns.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";
import { normalizeUrl } from "../../mcp/normalize-url.js";

export const ExtractChromParetoFrontIn = z.object({
  campaign_id: z.string().uuid(),
  // Override the default objective directions if the campaign used a
  // non-standard output set.
  output_directions: z
    .record(z.enum(["maximize", "minimize"]))
    .optional(),
});
export type ExtractChromParetoFrontInput = z.infer<typeof ExtractChromParetoFrontIn>;

const MeasuredItem = z.object({
  factor_values: z.record(z.unknown()),
  outputs: z.record(z.number()),
});

export const ExtractChromParetoFrontOut = z.object({
  campaign_id: z.string().uuid(),
  pareto: z.array(MeasuredItem),
  n_total: z.number().int(),
  n_pareto: z.number().int(),
  output_directions: z.record(z.string()),
});
export type ExtractChromParetoFrontOutput = z.infer<typeof ExtractChromParetoFrontOut>;

const ExtractParetoOut = z.object({
  pareto: z.array(MeasuredItem),
  n_total: z.number().int(),
  n_pareto: z.number().int(),
  output_directions: z.record(z.string()),
});

const DEFAULT_DIRECTIONS: Record<string, "maximize" | "minimize"> = {
  min_resolution: "maximize",
  runtime_min: "minimize",
  solvent_pmi_g: "minimize",
};

const TIMEOUT_MS = 15_000;

interface RoundRow {
  measured_outcomes: unknown;
}

export function buildExtractChromParetoFrontTool(pool: Pool, optimizerUrl: string) {
  const base = normalizeUrl(optimizerUrl);
  return defineTool({
    id: "extract_chrom_pareto_front",
    description:
      "Return the non-dominated (Pareto-optimal) HPLC methods for a " +
      "multi-objective chromatography optimization campaign — the trade-off " +
      "frontier over min-resolution (maximize) × runtime (minimize) × " +
      "solvent footprint (minimize). Reads all measured outcomes from the " +
      "campaign's rounds (RLS-scoped). Use this after a few rounds to let " +
      "the chemist pick the method that balances resolution, speed, and " +
      "green-ness for their needs.",
    inputSchema: ExtractChromParetoFrontIn,
    outputSchema: ExtractChromParetoFrontOut,
    annotations: { readOnly: true },

    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) {
        throw new Error("extract_chrom_pareto_front requires userEntraId in context");
      }

      const measured = await withUserContext(pool, userEntraId, async (client) => {
        // Confirm the campaign is visible (RLS); a non-visible / absent id
        // must throw, not return an empty front.
        const camp = await client.query<{ id: string }>(
          `SELECT id::text FROM optimization_campaigns WHERE id = $1`,
          [input.campaign_id],
        );
        if (camp.rows[0] === undefined) {
          throw new Error("campaign_not_found");
        }
        const rounds = await client.query<RoundRow>(
          `SELECT measured_outcomes FROM optimization_rounds WHERE campaign_id = $1`,
          [input.campaign_id],
        );
        const all: unknown[] = [];
        for (const r of rounds.rows) {
          if (Array.isArray(r.measured_outcomes)) {
            for (const item of r.measured_outcomes) all.push(item);
          }
        }
        return all;
      });

      if (measured.length === 0) {
        return ExtractChromParetoFrontOut.parse({
          campaign_id: input.campaign_id,
          pareto: [],
          n_total: 0,
          n_pareto: 0,
          output_directions: input.output_directions ?? DEFAULT_DIRECTIONS,
        });
      }

      // Default directions, optionally narrowed to the keys actually present
      // in the first measured outcome's outputs.
      let directions = input.output_directions ?? DEFAULT_DIRECTIONS;
      if (!input.output_directions) {
        // `measured` is non-empty here (we returned early when length === 0).
        const first = measured[0] as { outputs?: Record<string, unknown> };
        const keys = Object.keys(first.outputs ?? {});
        const narrowed: Record<string, "maximize" | "minimize"> = {};
        for (const k of keys) {
          const dir = DEFAULT_DIRECTIONS[k];
          if (dir !== undefined) narrowed[k] = dir;
          else if (k === "crf_total") narrowed[k] = "maximize";
        }
        if (Object.keys(narrowed).length > 0) directions = narrowed;
      }

      const res = await postJson(
        `${base}/extract_pareto`,
        { measured_outcomes: measured, output_directions: directions },
        ExtractParetoOut,
        TIMEOUT_MS,
        "mcp-chrom-method-optimizer",
      );

      return ExtractChromParetoFrontOut.parse({
        campaign_id: input.campaign_id,
        pareto: res.pareto,
        n_total: res.n_total,
        n_pareto: res.n_pareto,
        output_directions: res.output_directions,
      });
    },
  });
}
