// ingest_chrom_results — score measured chromatograms and record them as a
// round's measured outcomes.
//
// The chemist runs the proposed batch of HPLC methods on a method-development
// pump; the resulting datasets (peak lists) land in LOGS-by-SciY. The agent
// pulls them, then calls this builtin with one entry per measured proposal:
// each carries the proposal index (into the round's proposals array), the
// detected peak list, and optional method context (runtime, solvent, flow,
// %B, target compounds). The builtin scores each chromatogram via
// mcp_chrom_method_optimizer /score_chromatogram (Niezen-Desmet CRF + the
// MO objectives), builds measured_outcomes = {factor_values: <from the
// proposal>, outputs: <scored objectives>}, and writes them to
// optimization_rounds.measured_outcomes (RLS-scoped). The next
// recommend_next_chrom_batch call then incorporates them.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";
import { normalizeUrl } from "../../mcp/normalize-url.js";

const Peak = z.record(z.unknown());
const TargetCompound = z.object({
  name: z.string().min(1).max(200),
  m_z: z.number().nullable().optional(),
  // Optional DAD-UV reference spectrum (flat array of absorbances at a
  // fixed wavelength grid); the MCP matches by cosine similarity ≥ 0.95
  // when both target and detected peak carry one.
  spectrum: z.array(z.number()).max(1024).optional(),
});

const MeasuredRun = z.object({
  proposal_index: z.number().int().min(0).max(199),
  peaks: z.array(Peak).max(2000),
  targets: z.array(TargetCompound).max(200).default([]),
  // Optional method context — if omitted, runtime falls back to the last
  // peak's retention time and the solvent-PMI objective is 0. b_solvent
  // / b_meoh_fraction are auto-pulled from the proposal's factor_values
  // when this run object omits them.
  runtime_min: z.number().positive().optional(),
  b_solvent: z.string().max(50).optional(),
  b_meoh_fraction: z.number().min(0).max(1).optional(),
  flow_mLmin: z.number().positive().optional(),
  avg_pctB: z.number().min(0).max(100).optional(),
});

export const IngestChromResultsIn = z.object({
  round_id: z.string().uuid(),
  runs: z.array(MeasuredRun).min(1).max(200),
  rs_target: z.number().positive().default(1.5),
  runtime_target_min: z.number().positive().default(8.0),
});
export type IngestChromResultsInput = z.infer<typeof IngestChromResultsIn>;

export const IngestChromResultsOut = z.object({
  round_id: z.string().uuid(),
  campaign_id: z.string().uuid(),
  n_outcomes: z.number().int(),
  ingested_at: z.string(),
  scored: z.array(z.object({
    proposal_index: z.number().int(),
    crf_total: z.number(),
    min_resolution: z.number(),
    runtime_min: z.number(),
    solvent_pmi_g: z.number(),
    tracking_confidence: z.string(),
  })),
});
export type IngestChromResultsOutput = z.infer<typeof IngestChromResultsOut>;

const ScoreOut = z.object({
  crf_total: z.number(),
  min_resolution: z.number(),
  n_resolved_pairs: z.number().int(),
  n_peaks: z.number().int(),
  runtime_min: z.number(),
  solvent_pmi_g: z.number(),
  resolutions: z.array(z.number()),
  resolution_target_met: z.boolean(),
  tracking_confidence: z.string(),
  unmatched_targets: z.array(z.string()),
});

const TIMEOUT_MS = 30_000;

interface RoundLookup {
  campaign_id: string;
  proposals: unknown;
  ingested_results_at: string | null;
}

export function buildIngestChromResultsTool(pool: Pool, optimizerUrl: string) {
  const base = normalizeUrl(optimizerUrl);
  return defineTool({
    id: "ingest_chrom_results",
    description:
      "Score measured chromatograms for a chromatography optimization round " +
      "and record them as the round's measured outcomes. For each proposal " +
      "you ran, pass the proposal_index + detected peak list (+ optional " +
      "method context and target compounds). Computes the Niezen-Desmet CRF " +
      "and the min-resolution / runtime / solvent-PMI objectives via the MCP, " +
      "writes optimization_rounds.measured_outcomes (RLS-scoped), so the next " +
      "recommend_next_chrom_batch call learns from them.",
    inputSchema: IngestChromResultsIn,
    outputSchema: IngestChromResultsOut,
    annotations: { readOnly: false },

    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) {
        throw new Error("ingest_chrom_results requires userEntraId in context");
      }

      // 1. Pull the round + proposals under RLS; refuse if already ingested.
      const lookup = await withUserContext(pool, userEntraId, async (client) => {
        const r = await client.query<RoundLookup>(
          `SELECT campaign_id::text, proposals, ingested_results_at::text
             FROM optimization_rounds WHERE id = $1`,
          [input.round_id],
        );
        const row = r.rows[0];
        if (row === undefined) {
          throw new Error("round_not_found");
        }
        if (row.ingested_results_at !== null) {
          throw new Error("round_already_ingested");
        }
        return row;
      });
      if (!Array.isArray(lookup.proposals)) {
        throw new Error("proposals_corrupt");
      }
      const proposals = lookup.proposals as Array<{ factor_values?: unknown }>;

      // 2. Score each run via the MCP. When the caller omits method
      //    context, fall back to the proposal's factor_values — that way
      //    the chemist doesn't have to re-state b_solvent / flow / T per
      //    run.
      const measured: Array<{ factor_values: unknown; outputs: Record<string, number> }> = [];
      const scored: IngestChromResultsOutput["scored"] = [];
      for (const run of input.runs) {
        const proposal = proposals[run.proposal_index];
        if (proposal === undefined) {
          throw new Error(`proposal_index_out_of_range:${run.proposal_index}`);
        }
        const fv = (proposal.factor_values ?? {}) as Record<string, unknown>;
        const pickStr = (k: string): string | null => {
          const v = fv[k];
          return typeof v === "string" ? v : null;
        };
        const pickNum = (k: string): number | null => {
          const v = fv[k];
          return typeof v === "number" ? v : null;
        };
        const b_solvent = run.b_solvent ?? pickStr("b_solvent");
        const b_meoh_fraction = run.b_meoh_fraction ?? pickNum("b_meoh_fraction");
        const flow_mLmin = run.flow_mLmin ?? pickNum("flow_mLmin");
        const s = await postJson(
          `${base}/score_chromatogram`,
          {
            peaks: run.peaks,
            targets: run.targets,
            rs_target: input.rs_target,
            runtime_target_min: input.runtime_target_min,
            runtime_min: run.runtime_min ?? null,
            b_solvent,
            b_meoh_fraction,
            flow_mLmin,
            avg_pctB: run.avg_pctB ?? null,
          },
          ScoreOut,
          TIMEOUT_MS,
          "mcp-chrom-method-optimizer",
        );
        measured.push({
          factor_values: (proposal.factor_values ?? {}),
          outputs: {
            crf_total: s.crf_total,
            min_resolution: s.min_resolution,
            runtime_min: s.runtime_min,
            solvent_pmi_g: s.solvent_pmi_g,
          },
        });
        scored.push({
          proposal_index: run.proposal_index,
          crf_total: s.crf_total,
          min_resolution: s.min_resolution,
          runtime_min: s.runtime_min,
          solvent_pmi_g: s.solvent_pmi_g,
          tracking_confidence: s.tracking_confidence,
        });
      }

      // 3. Write measured_outcomes (RLS-scoped, idempotency-guarded).
      const updated = await withUserContext(pool, userEntraId, async (client) => {
        const result = await client.query<{ campaign_id: string; ingested_results_at: string }>(
          `UPDATE optimization_rounds
              SET measured_outcomes = $2::jsonb,
                  ingested_results_at = NOW()
            WHERE id = $1 AND ingested_results_at IS NULL
            RETURNING campaign_id::text, ingested_results_at::text`,
          [input.round_id, JSON.stringify(measured)],
        );
        const row = result.rows[0];
        if (!row) {
          throw new Error("round_already_ingested");
        }
        return row;
      });

      return IngestChromResultsOut.parse({
        round_id: input.round_id,
        campaign_id: updated.campaign_id,
        n_outcomes: measured.length,
        ingested_at: updated.ingested_results_at,
        scored,
      });
    },
  });
}
