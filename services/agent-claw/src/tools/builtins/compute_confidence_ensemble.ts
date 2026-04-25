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
  type ConfidenceEnsemble,
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
    brier_estimate: z.number().optional(),
  }),
  persisted: z.boolean(),
});

export type ComputeConfidenceEnsembleOutput = z.infer<typeof ComputeConfidenceEnsembleOut>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildComputeConfidenceEnsembleTool(pool: Pool) {
  return defineTool({
    id: "compute_confidence_ensemble",
    description:
      "Compute a confidence ensemble (verbalized + Bayesian + cross-model signals) " +
      "for an artifact previously persisted this turn. Stores the result in " +
      "artifacts.confidence_ensemble and returns the ensemble breakdown.",
    inputSchema: ComputeConfidenceEnsembleIn,
    outputSchema: ComputeConfidenceEnsembleOut,
    execute: async (ctx, input) => {
      return withUserContext(pool, ctx.userEntraId, async (client) => {
        // Fetch the artifact payload.
        const { rows } = await client.query<{ id: string; payload: unknown }>(
          "SELECT id::text AS id, payload FROM artifacts WHERE id = $1::uuid",
          [input.artifact_id],
        );
        if (rows.length === 0) {
          throw new Error(`artifact not found: ${input.artifact_id}`);
        }
        const row = rows[0]!;

        // Signal 1: verbalized confidence.
        const verbalized = extractVerbalizedConfidence(row.payload);

        // Signal 2: cross-model agreement — stubbed off (Phase E wiring).
        const cross_model: number | null = input.cross_model_enabled ? null : null;
        // NOTE: cross_model_enabled=true is wired but the second-model call
        // is deferred to Phase E. The column is reserved for that integration.

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
