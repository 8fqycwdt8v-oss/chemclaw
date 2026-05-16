// services/agent-claw/src/core/hooks/compute-result-writer.ts
//
// post_tool hook: compute-result-writer
//
// Persists chemistry prediction tool outputs to the `compute_results`
// canonical store (db/init/56_compute_results.sql) so they survive session
// expiry and can be replayed from the event log.
//
// Activation:
//   - Only chemistry tools: those with a non-null `result_schema_id` in the
//     registry (propose_retrosynthesis, predict_yield_with_uq,
//     predict_molecular_property, elucidate_mechanism, qm_single_point,
//     qm_crest_screen, assess_applicability_domain, identify_unknown_from_ms,
//     predict_reaction_yield, statistical_analyze, generate_focused_library).
//   - Requires a non-null `ctx.nceProjectId` — project-scope is mandatory
//     per the compute_results RLS design.
//   - Feature-flagged by `chemistry.compute_results.persist` (default false).
//     Default-off until operators decide on KG fan-out shape.
//
// Cache semantics:
//   ON CONFLICT (tool_id, input_hash, nce_project_id, model_id) DO UPDATE
//   refreshes payload + tool_confidence + resets valid_to=NULL. A second
//   call with the same input is a cache hit; only the output is refreshed.
//
// Confidence extraction:
//   - `total_score` (retrosynthesis route score)
//   - `ensemble_mean` (predict_yield_with_uq)
//   - `value` on the first prediction (chemprop property, normalised to [0,1]
//     clamped at ±10 for logP/logS or ±500 for mp/bp)
//   - Falls back to null when none of the above are found.

import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { Lifecycle } from "../lifecycle.js";
import type { PostToolPayload } from "../types.js";
import type { HookJSONOutput } from "../hook-output.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { getLogger } from "../../observability/logger.js";

const FEATURE_FLAG_KEY = "chemistry.compute_results.persist";

export interface ComputeResultWriterDeps {
  pool: Pool;
  registry: ToolRegistry;
  isFeatureEnabled: (
    key: string,
    ctx: { user: string; project: string | null },
  ) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canonicalInputHash(input: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const replacer = (_: string, v: any): unknown =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort())
      : (v as unknown);
  const sorted = input === undefined ? "null" : JSON.stringify(input, replacer);
  return createHash("sha256").update(sorted).digest("hex");
}

function extractModelId(output: unknown): string {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return "";
  const obj = output as Record<string, unknown>;
  if (typeof obj.model_id === "string") return obj.model_id;
  return "";
}

/**
 * Extract a [0,1] tool confidence from the output when available.
 * Returns null when the output shape doesn't carry a recognisable score.
 */
function extractToolConfidence(output: unknown): number | null {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return null;
  const obj = output as Record<string, unknown>;

  // Retrosynthesis: best route total_score (0–1 from ASKCOS / AiZynth).
  if (Array.isArray(obj.routes_askcos) && obj.routes_askcos.length > 0) {
    const r = obj.routes_askcos[0] as Record<string, unknown>;
    if (typeof r.total_score === "number") {
      return Math.max(0, Math.min(1, r.total_score));
    }
  }
  if (Array.isArray(obj.routes_aizynth) && obj.routes_aizynth.length > 0) {
    const r = obj.routes_aizynth[0] as Record<string, unknown>;
    if (typeof r.score === "number") {
      return Math.max(0, Math.min(1, r.score));
    }
  }

  // Yield prediction: ensemble_mean is already 0–100; normalise to 0–1.
  if (typeof obj.ensemble_mean === "number") {
    return Math.max(0, Math.min(1, obj.ensemble_mean / 100));
  }

  // predictions[] aggregate: average ensemble_mean / std-derived confidence.
  if (Array.isArray(obj.predictions) && obj.predictions.length > 0) {
    const scores: number[] = [];
    for (const p of obj.predictions) {
      if (p === null || typeof p !== "object" || Array.isArray(p)) continue;
      const pred = p as Record<string, unknown>;
      if (typeof pred.ensemble_mean === "number") {
        scores.push(Math.max(0, Math.min(1, pred.ensemble_mean / 100)));
      }
    }
    if (scores.length > 0) {
      return scores.reduce((a, b) => a + b, 0) / scores.length;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export function registerComputeResultWriterHook(
  lifecycle: Lifecycle,
  deps: ComputeResultWriterDeps,
): void {
  const log = getLogger("compute-result-writer");

  lifecycle.on(
    "post_tool",
    "compute-result-writer",
    async (payload: PostToolPayload, _toolUseId, _opts): Promise<HookJSONOutput> => {
      try {
        const { ctx, toolId, input, output } = payload;

        // Only chemistry tools (those with result_schema_id).
        const tool = deps.registry.get(toolId);
        if (!tool?.result_schema_id) return {};

        // Project scope is required for compute_results RLS.
        if (!ctx.nceProjectId) return {};

        // Feature-flag gate — default off.
        const enabled = await deps.isFeatureEnabled(FEATURE_FLAG_KEY, {
          user: ctx.userEntraId,
          project: ctx.nceProjectId,
        });
        if (!enabled) return {};

        const inputHash = canonicalInputHash(input);
        const modelId = extractModelId(output);
        const toolConfidence = extractToolConfidence(output);

        await deps.pool.query(
          `INSERT INTO compute_results
              (tool_id, input_hash, nce_project_id, model_id,
               payload, tool_confidence,
               agent_trace_id, created_by_user_entra_id)
           VALUES ($1, $2, $3::uuid, $4, $5::jsonb, $6,
                   $7, $8)
           ON CONFLICT ON CONSTRAINT compute_results_cache_key
           DO UPDATE SET
             payload          = EXCLUDED.payload,
             tool_confidence  = EXCLUDED.tool_confidence,
             valid_to         = NULL`,
          [
            toolId,
            inputHash,
            ctx.nceProjectId,
            modelId,
            JSON.stringify(output ?? null),
            toolConfidence ?? null,
            null,
            ctx.userEntraId,
          ],
        );
      } catch (err) {
        log.warn({ err, toolId: payload.toolId }, "compute-result-writer failed");
      }
      return {};
    },
  );
}
