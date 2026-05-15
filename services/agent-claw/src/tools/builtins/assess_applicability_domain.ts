// assess_applicability_domain — three-signal AD verdict (Z1).
//
// Orchestrates: drfp encode → pgvector nearest-neighbor (RLS) → calibration
// pull (project, fallback to cross-RLS) → chemprop predict → residuals →
// /calibrate → /assess. Cache miss on /assess re-supplies once.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";
import { appendAudit } from "../../routes/admin/audit-log.js";
import { getLogger } from "../../observability/logger.js";
import { MAX_RXN_SMILES_LEN } from "../_limits.js";
import { normalizeUrl } from "../../mcp/normalize-url.js";

const log = getLogger("assess_applicability_domain");

const CONFORMAL_MIN_N = 30;
const CALIBRATION_LIMIT = 100;

// ---------- Schemas ---------------------------------------------------------

export const AssessApplicabilityDomainIn = z.object({
  rxn_smiles: z.string().min(3).max(MAX_RXN_SMILES_LEN),
  project_internal_id: z.string().max(200).optional(),
});
export type AssessApplicabilityDomainInput = z.infer<typeof AssessApplicabilityDomainIn>;

const TanimotoSignal = z.object({
  distance: z.number(),
  tanimoto: z.number(),
  threshold_in: z.number(),
  threshold_out: z.number(),
  in_band: z.boolean(),
});

const MahalanobisSignal = z.object({
  mahalanobis: z.number(),
  threshold_in: z.number(),
  threshold_out: z.number(),
  in_band: z.boolean(),
  stats_version: z.string(),
  n_train: z.number().int(),
});

const ConformalSignal = z.object({
  alpha: z.number(),
  half_width: z.number(),
  calibration_size: z.number().int(),
  used_global_fallback: z.boolean(),
  threshold_in: z.number(),
  threshold_out: z.number(),
  in_band: z.boolean(),
});

export const AssessApplicabilityDomainOut = z.object({
  verdict: z.enum(["in_domain", "borderline", "out_of_domain"]),
  tanimoto_signal: TanimotoSignal,
  mahalanobis_signal: MahalanobisSignal,
  conformal_signal: ConformalSignal.nullable(),
  used_global_fallback: z.boolean(),
});
export type AssessApplicabilityDomainOutput = z.infer<typeof AssessApplicabilityDomainOut>;

// MCP response schemas (intentionally narrow — the AD MCP enforces the rest).
const DrfpEncodeOut = z.object({
  vector: z.array(z.number()),
  on_bit_count: z.number().int().nonnegative(),
});

const ChempropPredictYieldOut = z.object({
  predictions: z.array(
    z.object({
      rxn_smiles: z.string(),
      predicted_yield: z.number(),
      std: z.number(),
      model_id: z.string(),
    }),
  ),
});

const CalibrateOut = z.object({
  calibration_id: z.string(),
  calibration_size: z.number().int(),
  cached_for_seconds: z.number().int(),
});

// ---------- Helpers ---------------------------------------------------------

function toVectorLiteral(bits: number[]): string {
  return "[" + bits.map((b) => (b ? "1" : "0")).join(",") + "]";
}

interface CalibrationRow {
  rxn_smiles: string;
  yield_pct: number;
}

async function fetchCalibrationRows(
  pool: Pool,
  userEntraId: string,
  projectInternalId: string | undefined,
): Promise<{ rows: CalibrationRow[]; usedGlobalFallback: boolean }> {
  return await withUserContext(pool, userEntraId, async (client) => {
    let projectRows: CalibrationRow[] = [];
    if (projectInternalId) {
      const result = await client.query<CalibrationRow>(
        // reactions_current excludes invalidated/superseded rows; calibration
        // sets must not pollute conformal thresholds with retracted data.
        `SELECT r.rxn_smiles, e.yield_pct::float AS yield_pct
           FROM reactions_current r
           JOIN experiments e ON e.id = r.experiment_id
           JOIN synthetic_steps s ON s.id = e.synthetic_step_id
           JOIN nce_projects p ON p.id = s.nce_project_id
          WHERE p.internal_id = $1
            AND e.yield_pct IS NOT NULL
            AND r.rxn_smiles IS NOT NULL
          LIMIT $2`,
        [projectInternalId, CALIBRATION_LIMIT],
      );
      projectRows = result.rows;
    }
    if (projectRows.length >= CONFORMAL_MIN_N) {
      return { rows: projectRows, usedGlobalFallback: false };
    }
    // Bootstrap: pull cross-RLS-accessible calibration data without the
    // project filter. Still RLS-scoped — only projects this user can see.
    const result = await client.query<CalibrationRow>(
      `SELECT r.rxn_smiles, e.yield_pct::float AS yield_pct
         FROM reactions_current r
         JOIN experiments e ON e.id = r.experiment_id
        WHERE e.yield_pct IS NOT NULL
          AND r.rxn_smiles IS NOT NULL
        LIMIT $1`,
      [CALIBRATION_LIMIT],
    );
    return { rows: result.rows, usedGlobalFallback: true };
  });
}

async function fetchNearestDistance(
  pool: Pool,
  userEntraId: string,
  vectorLiteral: string,
): Promise<number | null> {
  return await withUserContext(pool, userEntraId, async (client) => {
    const result = await client.query<{ distance: number }>(
      `SELECT r.drfp_vector <=> $1::vector AS distance
         FROM reactions_current r
        WHERE r.drfp_vector IS NOT NULL
        ORDER BY r.drfp_vector <=> $1::vector ASC
        LIMIT 1`,
      [vectorLiteral],
    );
    const first = result.rows[0];
    return first ? first.distance : null;
  });
}

// ---------- Factory --------------------------------------------------------

export function buildAssessApplicabilityDomainTool(
  pool: Pool,
  drfpUrl: string,
  chempropUrl: string,
  adUrl: string,
) {
  const drfpBase = normalizeUrl(drfpUrl);
  const chempropBase = normalizeUrl(chempropUrl);
  const adBase = normalizeUrl(adUrl);

  return defineTool({
    id: "assess_applicability_domain",
    description:
      "Three-signal applicability-domain verdict for a reaction: Tanimoto-NN " +
      "in DRFP space, Mahalanobis in feature space, and conformal-prediction " +
      "interval width. Returns the verdict ('in_domain' / 'borderline' / " +
      "'out_of_domain') plus all underlying scores. Annotate-don't-block: the " +
      "verdict is descriptive; the chemist still sees every recommendation.",
    inputSchema: AssessApplicabilityDomainIn,
    outputSchema: AssessApplicabilityDomainOut,
    result_schema_id: "assess.v1",
    annotations: { readOnly: true },

    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) {
        throw new Error("assess_applicability_domain requires userEntraId in context");
      }

      // 1. Encode the query reaction.
      const encoded = await postJson(
        `${drfpBase}/encode`,
        { rxn_smiles: input.rxn_smiles },
        DrfpEncodeOut,
        15_000,
        "mcp-drfp",
      );
      const vectorLiteral = toVectorLiteral(encoded.vector);

      // 2. Nearest-neighbor distance (RLS).
      const nearestDistance = await fetchNearestDistance(pool, userEntraId, vectorLiteral);

      // 3. Calibration pull (RLS), with cross-project bootstrap fallback.
      const { rows: calibrationRows, usedGlobalFallback } = await fetchCalibrationRows(
        pool,
        userEntraId,
        input.project_internal_id,
      );

      // Track D sibling (kg-transfer-learning.md §7 Q6): every bootstrap
      // fallback gets a row in admin_audit_log so admins can review the
      // pattern. The fallback is RLS-safe (the cross-project read still
      // rides withUserContext) but it's the only existing cross-project
      // surface in the agent — and prior to this it had no audit trail.
      // We deliberately omit rxn_smiles from the payload: SMILES are
      // sensitive and admins can pivot via trace_id (auto-populated by
      // appendAudit) to find the originating span in Langfuse.
      // Audit failures must not block the AD verdict — log and continue.
      if (usedGlobalFallback) {
        try {
          await appendAudit(pool, {
            actor: userEntraId,
            action: "ad.cross_project_bootstrap_used",
            target: input.project_internal_id ?? "__no_project_id__",
            afterValue: {
              calibration_size: calibrationRows.length,
              project_internal_id_supplied: input.project_internal_id != null,
            },
            reason: "AD calibration fell back to cross-project pool",
          });
        } catch (err) {
          log.warn(
            { err, projectInternalId: input.project_internal_id },
            "failed to record ad.cross_project_bootstrap_used audit row",
          );
        }
      }

      // 4. Conformal abstain when even the cross-project pool is too small.
      const conformalAbstain = calibrationRows.length < CONFORMAL_MIN_N;

      // 5. Build the /assess request body.
      let calibrationId: string | null = null;

      if (!conformalAbstain) {
        const predResp = await postJson(
          `${chempropBase}/predict_yield`,
          { rxn_smiles_list: calibrationRows.map((r) => r.rxn_smiles) },
          ChempropPredictYieldOut,
          60_000,
          "mcp-chemprop",
        );
        const residuals: number[] = [];
        for (let i = 0; i < predResp.predictions.length; i++) {
          const row = calibrationRows[i];
          const pred = predResp.predictions[i];
          if (!row || !pred) break;
          residuals.push(Math.abs(row.yield_pct - pred.predicted_yield));
        }

        const calibrated = await postJson(
          `${adBase}/calibrate`,
          {
            project_id: input.project_internal_id ?? "__cross_project_bootstrap__",
            residuals,
          },
          CalibrateOut,
          10_000,
          "mcp-applicability-domain",
        );
        calibrationId = calibrated.calibration_id;
      }

      // 6. Issue the /assess call.
      const assessBody = {
        query_drfp_vector: encoded.vector,
        nearest_neighbor_distance: nearestDistance ?? 1.0,
        calibration_id: calibrationId,
        inline_residuals: [] as number[],
      };

      try {
        return await postJson(
          `${adBase}/assess`,
          assessBody,
          AssessApplicabilityDomainOut,
          15_000,
          "mcp-applicability-domain",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Cache miss after restart. Re-supply once via /calibrate, then retry.
        if (msg.includes("404") && !conformalAbstain && input.project_internal_id) {
          const predResp = await postJson(
            `${chempropBase}/predict_yield`,
            { rxn_smiles_list: calibrationRows.map((r) => r.rxn_smiles) },
            ChempropPredictYieldOut,
            60_000,
            "mcp-chemprop",
          );
          const residuals: number[] = [];
          for (let i = 0; i < predResp.predictions.length; i++) {
            const row = calibrationRows[i];
            const pred = predResp.predictions[i];
            if (!row || !pred) break;
            residuals.push(Math.abs(row.yield_pct - pred.predicted_yield));
          }
          const recalibrated = await postJson(
            `${adBase}/calibrate`,
            { project_id: input.project_internal_id, residuals },
            CalibrateOut,
            10_000,
            "mcp-applicability-domain",
          );
          // Mark fallback for traceability (caller already knows from the row counts).
          void usedGlobalFallback;
          return await postJson(
            `${adBase}/assess`,
            { ...assessBody, calibration_id: recalibrated.calibration_id },
            AssessApplicabilityDomainOut,
            15_000,
            "mcp-applicability-domain",
          );
        }
        throw err;
      }
    },
  });
}
