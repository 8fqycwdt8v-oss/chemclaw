// compute_confidence_ensemble — Phase C.5 builtin.
//
// On-demand confidence ensemble for an artifact. Runs the three signals:
//   1. Verbalized self-uncertainty (from artifact.payload.confidence field)
//   2. Cross-model agreement (off by default; gate on harness.confidence.cross_model)
//   3. Bayesian posterior (from KG prior counts if available)
//
// Stores the result in artifacts.confidence_ensemble and returns it.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";
import {
  extractVerbalizedConfidence,
  computeBayesianPosterior,
  composeEnsemble,
  crossModelAgreement,
  type ConfidenceEnsemble,
  type CrossModelLlmProvider,
  type KgPriorCounts,
} from "../../core/confidence.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ComputeConfidenceEnsembleIn = z.object({
  artifact_id: z.string().uuid().describe("UUID of the artifact to score."),
  /**
   * Optional KG prior counts for the primary predicate being asserted.
   * If provided, the Bayesian signal is computed.
   */
  kg_prior: z
    .object({
      successes: z.number().int().nonnegative(),
      total: z.number().int().positive(),
    })
    .optional()
    .describe("KG prior counts for Beta-Binomial posterior. Omit if unavailable."),
  /**
   * If true, cross-model agreement signal is enabled (sampling a second model).
   * Off by default — costs an extra LLM call.
   */
  cross_model_enabled: z.boolean().optional().default(false),
});

export type ComputeConfidenceEnsembleInput = z.infer<typeof ComputeConfidenceEnsembleIn>;

export const ComputeConfidenceEnsembleOut = z.object({
  artifact_id: z.string().uuid(),
  confidence_ensemble: z.object({
    verbalized: z.number().nullable(),
    cross_model: z.number().nullable(),
    bayesian: z
      .object({
        mean: z.number(),
        ci_low: z.number(),
        ci_high: z.number(),
      })
      .nullable(),
    overall: z.number(),
    // Tranche 2 / M3 — categorical label + structured per-signal record so
    // the LLM can reason about each signal independently.
    confidence_label: z.enum(["foundational", "high", "medium", "low"]),
    signals: z.array(
      z.object({
        name: z.enum(["verbalized", "cross_model", "bayesian"]),
        score: z.number().nullable(),
        weight: z.number(),
        present: z.boolean(),
      }),
    ),
    brier_estimate: z.number().optional(),
  }),
  persisted: z.boolean(),
});

export type ComputeConfidenceEnsembleOutput = z.infer<typeof ComputeConfidenceEnsembleOut>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildComputeConfidenceEnsembleTool(
  pool: Pool,
  llm?: CrossModelLlmProvider,
) {
  return defineTool({
    id: "compute_confidence_ensemble",
    description:
      "Compute a confidence ensemble (verbalized + Bayesian + cross-model signals) " +
      "for an artifact previously persisted this turn. Stores the result in " +
      "artifacts.confidence_ensemble and returns the ensemble breakdown plus a " +
      "categorical confidence_label (foundational | high | medium | low).",
    inputSchema: ComputeConfidenceEnsembleIn,
    outputSchema: ComputeConfidenceEnsembleOut,
    execute: async (ctx, input) => {
      return await withUserContext(pool, ctx.userEntraId, async (client) => {
        // Fetch the artifact payload. Bi-temporal: refuse to score
        // superseded artifacts so the agent doesn't compound staleness
        // by attaching a fresh ensemble to a retracted record.
        const { rows } = await client.query<{ id: string; payload: unknown }>(
          "SELECT id::text AS id, payload FROM artifacts WHERE id = $1::uuid AND superseded_at IS NULL",
          [input.artifact_id],
        );
        const row = rows[0];
        if (!row) {
          throw new Error(`artifact not found: ${input.artifact_id}`);
        }

        // Signal 1: verbalized confidence.
        const verbalized = extractVerbalizedConfidence(row.payload);

        // Signal 2: cross-model agreement.
        //
        // Tranche 2 / M2: when an LlmProvider is wired AND the caller opts
        // in, sample the judge model and use its agreement score. Without
        // an LlmProvider (older callers, tests), fall through to null —
        // the ensemble composer redistributes the weight to the remaining
        // signals so the overall score stays sensible.
        let cross_model: number | null = null;
        if (input.cross_model_enabled && llm !== undefined) {
          const text = JSON.stringify(row.payload).slice(0, 4_000);
          cross_model = await crossModelAgreement(text, llm);
        }

        // Signal 3: Bayesian posterior.
        let bayesian: ReturnType<typeof computeBayesianPosterior> | null = null;
        if (input.kg_prior) {
          const prior: KgPriorCounts = input.kg_prior;
          if (prior.successes <= prior.total) {
            bayesian = computeBayesianPosterior(prior);
          }
        }

        const ensemble: ConfidenceEnsemble = composeEnsemble({
          verbalized,
          cross_model,
          bayesian,
        });

        // Persist back to artifacts.
        let persisted = false;
        try {
          await client.query(
            `UPDATE artifacts SET confidence_ensemble = $1::jsonb WHERE id = $2::uuid`,
            [JSON.stringify(ensemble), input.artifact_id],
          );
          persisted = true;
        } catch {
          // Non-fatal: return the computed value even if persistence fails.
        }

        return {
          artifact_id: row.id,
          confidence_ensemble: ensemble,
          persisted,
        };
      });
    },
  });
}
