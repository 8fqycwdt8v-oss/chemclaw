// simulate_chrom_retention — LSS retention simulation (cheap fidelity).
//
// Pure forward to mcp_chrom_method_optimizer /simulate_retention. Given
// either fitted Snyder-Dolan LSS parameters per analyte (log10_kw, S) OR
// isocratic scouting observations to fit them from, plus a gradient
// program and the column dead time t0, returns the simulated peak list
// and a scored CRF / min-resolution / runtime. The agent uses this to
// virtually screen many candidate gradients before committing real
// injections (a 2-stage / multi-fidelity warm start). No DB access.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { normalizeUrl } from "../../mcp/normalize-url.js";

const LssPair = z.tuple([z.number(), z.number()]);  // [log10_kw, S]
const PhiTr = z.tuple([z.number(), z.number()]);     // [phi, t_R_min]
const GradientRow = z.object({ time_min: z.number(), pctB: z.number() });

export const SimulateChromRetentionIn = z
  .object({
    lss_by_analyte: z.record(LssPair).optional(),
    scouting_observations: z.record(z.array(PhiTr).min(2)).optional(),
    gradient_program: z.array(GradientRow).min(2),
    t0_min: z.number().positive(),
    t_dwell_min: z.number().min(0).default(0),
    plate_count: z.number().int().positive().default(10000),
    rs_target: z.number().positive().default(1.5),
    runtime_target_min: z.number().positive().default(8.0),
    b_solvent: z.string().max(50).optional(),
    flow_mLmin: z.number().positive().optional(),
    avg_pctB: z.number().min(0).max(100).optional(),
  })
  .refine(
    (v) => v.lss_by_analyte !== undefined || v.scouting_observations !== undefined,
    { message: "provide either lss_by_analyte or scouting_observations" },
  );
export type SimulateChromRetentionInput = z.infer<typeof SimulateChromRetentionIn>;

export const SimulateChromRetentionOut = z.object({
  peaks: z.array(z.record(z.unknown())),
  lss_by_analyte: z.record(LssPair),
  crf_total: z.number(),
  min_resolution: z.number(),
  runtime_min: z.number(),
  solvent_pmi_g: z.number(),
  n_eluted: z.number().int(),
  n_analytes: z.number().int(),
});
export type SimulateChromRetentionOutput = z.infer<typeof SimulateChromRetentionOut>;

const TIMEOUT_MS = 30_000;

export function buildSimulateChromRetentionTool(optimizerUrl: string) {
  const base = normalizeUrl(optimizerUrl);
  return defineTool({
    id: "simulate_chrom_retention",
    description:
      "Simulate a chromatogram from a linear-solvent-strength (Snyder-Dolan) " +
      "retention model: given fitted LSS parameters per analyte (or isocratic " +
      "scouting observations to fit them from), a gradient program, and the " +
      "column dead time t0, returns the simulated peak list and a scored CRF / " +
      "min-resolution / runtime. Use it to virtually pre-screen many candidate " +
      "gradients before running real injections (cheap-fidelity warm start). " +
      "Caveat: LSS coefficients are condition-specific — same column / B-solvent " +
      "/ additive / temperature as the scouting runs.",
    inputSchema: SimulateChromRetentionIn,
    outputSchema: SimulateChromRetentionOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      const res = await postJson(
        `${base}/simulate_retention`,
        {
          lss_by_analyte: input.lss_by_analyte ?? null,
          scouting_observations: input.scouting_observations ?? null,
          gradient_program: input.gradient_program,
          t0_min: input.t0_min,
          t_dwell_min: input.t_dwell_min,
          plate_count: input.plate_count,
          rs_target: input.rs_target,
          runtime_target_min: input.runtime_target_min,
          b_solvent: input.b_solvent ?? null,
          flow_mLmin: input.flow_mLmin ?? null,
          avg_pctB: input.avg_pctB ?? null,
        },
        SimulateChromRetentionOut,
        TIMEOUT_MS,
        "mcp-chrom-method-optimizer",
      );
      return res;
    },
  });
}
