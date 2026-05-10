// ingest_campaign_results — record measured outcomes for a round.
//
// The chemist runs the proposed batch, measures yields, hands the results back
// to the agent. This builtin updates optimization_rounds.measured_outcomes
// (RLS-scoped) so the next recommend_next_batch call benefits from them.
//
// Validation: every measured outcome's factor / output keys are checked
// against the campaign's stored bofire_domain, and output values are
// validated against the campaign's optional output_bounds. Mistyped keys
// or out-of-range values fail loudly here instead of silently corrupting
// the GP fit downstream.
//
// Synthesis-campaign backfill: when the round belongs to a synthesis_campaigns
// umbrella (via optimization_campaigns.synthesis_campaign_id), the parent
// `bo_round` step is located and its outputs are atomically backfilled with
// `experiments_added` and `improved` so the bo_or_die die-gate has the
// deterministic signals it consumes.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";
import { getLogger } from "../../observability/logger.js";

const Outcome = z.object({
  factor_values: z.record(z.unknown()),
  outputs: z.record(z.number()),
});

export const IngestCampaignResultsIn = z.object({
  round_id: z.string().uuid(),
  measured_outcomes: z.array(Outcome).min(1).max(2000),
});
export type IngestCampaignResultsInput = z.infer<typeof IngestCampaignResultsIn>;

export const IngestCampaignResultsOut = z.object({
  round_id: z.string().uuid(),
  campaign_id: z.string().uuid(),
  n_outcomes: z.number().int(),
  ingested_at: z.string(),
  improved: z.boolean(),
  step_backfilled: z.boolean(),
});
export type IngestCampaignResultsOutput = z.infer<typeof IngestCampaignResultsOut>;

interface CampaignDomainRow {
  campaign_id: string;
  bofire_domain: unknown;
  output_bounds: unknown;
  synthesis_campaign_id: string | null;
}

interface UpdatedRow {
  campaign_id: string;
  ingested_results_at: string;
}

const log = getLogger("ingest_campaign_results");

interface BofireFeature { key: string }
interface BofireObjective { type?: string }
interface BofireOutputFeature { key: string; objective?: BofireObjective }
interface BofireDomainShape {
  inputs?: { features?: BofireFeature[] };
  outputs?: { features?: BofireOutputFeature[] };
}

function extractKeys(domain: unknown): {
  inputKeys: Set<string>;
  outputKeys: Set<string>;
  outputDirections: Map<string, "maximize" | "minimize">;
} {
  const d = (domain ?? {}) as BofireDomainShape;
  const inputFeats = d.inputs?.features ?? [];
  const outputFeats = d.outputs?.features ?? [];
  const inputKeys = new Set<string>();
  for (const f of inputFeats) {
    if (typeof f.key === "string") inputKeys.add(f.key);
  }
  const outputKeys = new Set<string>();
  const outputDirections = new Map<string, "maximize" | "minimize">();
  for (const f of outputFeats) {
    if (typeof f.key !== "string") continue;
    outputKeys.add(f.key);
    const objType = f.objective?.type ?? "";
    // Explicit allowlist: anything else (e.g. CloseToTarget) is unsupported
    // for the improvement-tracking signal and gets skipped silently.
    if (objType === "MaximizeObjective") outputDirections.set(f.key, "maximize");
    else if (objType === "MinimizeObjective") outputDirections.set(f.key, "minimize");
  }
  return { inputKeys, outputKeys, outputDirections };
}

interface OutputBoundsMap { [key: string]: { lo: number; hi: number } }

function validateOutcomes(
  outcomes: Array<z.infer<typeof Outcome>>,
  inputKeys: Set<string>,
  outputKeys: Set<string>,
  outputBounds: OutputBoundsMap,
): void {
  if (inputKeys.size === 0 && outputKeys.size === 0) {
    throw new Error("bofire_domain_missing_or_corrupt");
  }
  for (let i = 0; i < outcomes.length; i++) {
    const out = outcomes[i];
    if (!out) continue;
    for (const k of Object.keys(out.factor_values)) {
      if (!inputKeys.has(k)) {
        throw new Error(
          `unknown_factor_key:measured_outcomes[${i}].factor_values.${k}`,
        );
      }
    }
    for (const [k, v] of Object.entries(out.outputs)) {
      if (!outputKeys.has(k)) {
        throw new Error(
          `unknown_output_key:measured_outcomes[${i}].outputs.${k}`,
        );
      }
      if (!Number.isFinite(v)) {
        throw new Error(
          `output_not_finite:measured_outcomes[${i}].outputs.${k}=${v}`,
        );
      }
      const bound = outputBounds[k];
      if (bound !== undefined && (v < bound.lo || v > bound.hi)) {
        throw new Error(
          `output_out_of_bounds:measured_outcomes[${i}].outputs.${k}=${v} ` +
            `not in [${bound.lo}, ${bound.hi}]`,
        );
      }
    }
  }
}

// Compute "improved" by comparing the new round's best objective scalar to
// the prior best. Single-objective campaigns: direction-aware best of the
// declared objective. Multi-objective: the simple count of new outcomes
// that are not dominated by any prior outcome (≥1 → improved).
function computeImproved(
  newOutcomes: Array<z.infer<typeof Outcome>>,
  priorOutcomes: Array<{ outputs: Record<string, number> }>,
  directions: Map<string, "maximize" | "minimize">,
): boolean {
  if (directions.size === 0) return false;
  if (directions.size === 1) {
    const [name, dir] = Array.from(directions.entries())[0]!;
    const sign = dir === "maximize" ? 1 : -1;
    const newBest = Math.max(
      ...newOutcomes
        .map((o) => o.outputs[name])
        .filter((x): x is number => typeof x === "number")
        .map((x) => x * sign),
    );
    const priorBest = priorOutcomes.length === 0
      ? -Infinity
      : Math.max(
          ...priorOutcomes
            .map((o) => o.outputs[name])
            .filter((x): x is number => typeof x === "number")
            .map((x) => x * sign),
        );
    return Number.isFinite(newBest) && newBest > priorBest;
  }
  // Multi-objective: any new point not dominated by any prior point counts.
  if (priorOutcomes.length === 0) return newOutcomes.length > 0;
  const dirs = Array.from(directions.entries());
  for (const n of newOutcomes) {
    let dominated = false;
    for (const p of priorOutcomes) {
      let geAll = true;
      let gtAny = false;
      for (const [name, dir] of dirs) {
        const sign = dir === "maximize" ? 1 : -1;
        const nv = (n.outputs[name] ?? NaN) * sign;
        const pv = (p.outputs[name] ?? NaN) * sign;
        if (!Number.isFinite(nv) || !Number.isFinite(pv)) { geAll = false; break; }
        if (pv < nv) geAll = false;
        if (pv > nv) gtAny = true;
      }
      if (geAll && gtAny) { dominated = true; break; }
    }
    if (!dominated) return true;
  }
  return false;
}

export function buildIngestCampaignResultsTool(pool: Pool) {
  return defineTool({
    id: "ingest_campaign_results",
    description:
      "Record measured outcomes for a previously-proposed optimization round. " +
      "Validates factor / output keys against the campaign's BoFire Domain and " +
      "rejects out-of-bounds values. When the round belongs to a synthesis_campaigns " +
      "umbrella, the matching bo_round step is automatically backfilled with " +
      "experiments_added + improved so the bo_or_die die-gate sees real signals.",
    inputSchema: IngestCampaignResultsIn,
    outputSchema: IngestCampaignResultsOut,
    annotations: { readOnly: false },

    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) {
        throw new Error("ingest_campaign_results requires userEntraId in context");
      }

      const {
        updated,
        improved,
        backfilled,
      } = await withUserContext(pool, userEntraId, async (client) => {
        // 1. Pull the campaign + round so we can validate against the Domain
        // and aggregate prior outcomes for improvement detection.
        const campRes = await client.query<CampaignDomainRow>(
          `SELECT c.id::text                       AS campaign_id,
                  c.bofire_domain                  AS bofire_domain,
                  c.output_bounds                  AS output_bounds,
                  c.synthesis_campaign_id::text    AS synthesis_campaign_id
             FROM optimization_rounds r
             JOIN optimization_campaigns c ON c.id = r.campaign_id
            WHERE r.id = $1::uuid`,
          [input.round_id],
        );
        const camp = campRes.rows[0];
        if (camp === undefined) {
          throw new Error("round_not_found");
        }
        const { inputKeys, outputKeys, outputDirections } =
          extractKeys(camp.bofire_domain);
        const bounds = (camp.output_bounds ?? {}) as OutputBoundsMap;
        validateOutcomes(input.measured_outcomes, inputKeys, outputKeys, bounds);

        // Prior measured outcomes (across all rounds) for improvement detection.
        const priorRes = await client.query<{ measured_outcomes: unknown }>(
          `SELECT measured_outcomes
             FROM optimization_rounds
            WHERE campaign_id = $1::uuid AND id <> $2::uuid
              AND measured_outcomes IS NOT NULL`,
          [camp.campaign_id, input.round_id],
        );
        const priorOutcomes: Array<{ outputs: Record<string, number> }> = [];
        for (const r of priorRes.rows) {
          if (Array.isArray(r.measured_outcomes)) {
            for (const item of r.measured_outcomes as Array<unknown>) {
              if (
                item !== null &&
                typeof item === "object" &&
                "outputs" in item
              ) {
                const out = (item as { outputs?: Record<string, number> }).outputs ?? {};
                priorOutcomes.push({ outputs: out });
              }
            }
          }
        }

        const improvedFlag = computeImproved(
          input.measured_outcomes,
          priorOutcomes,
          outputDirections,
        );

        // 2. Idempotency-guarded UPDATE on optimization_rounds.
        const updateRes = await client.query<UpdatedRow>(
          `UPDATE optimization_rounds
              SET measured_outcomes = $2::jsonb,
                  ingested_results_at = NOW()
            WHERE id = $1
              AND ingested_results_at IS NULL
            RETURNING campaign_id::text,
                      ingested_results_at::text`,
          [input.round_id, JSON.stringify(input.measured_outcomes)],
        );
        const row = updateRes.rows[0];
        if (!row) {
          const exists = await client.query<{ ingested_results_at: string | null }>(
            `SELECT ingested_results_at FROM optimization_rounds WHERE id = $1`,
            [input.round_id],
          );
          if (exists.rows[0] === undefined) {
            throw new Error("round_not_found");
          }
          throw new Error("round_already_ingested");
        }

        // 3. Backfill the parent synthesis_campaign_steps row if this
        // optimization_rounds belongs to an umbrella. Two link shapes are
        // supported: ref_table/ref_id pointing at the round, or at the
        // campaign (whichever the orchestrator wired). Both are matched.
        let stepBackfilled = false;
        if (camp.synthesis_campaign_id !== null) {
          const stepUpd = await client.query<{ id: string }>(
            `UPDATE synthesis_campaign_steps
                SET outputs = outputs ||
                              jsonb_build_object(
                                'experiments_added', $4::int,
                                'improved',          $5::boolean,
                                'auto_backfilled_at', to_jsonb(NOW())
                              ),
                    updated_at = NOW()
              WHERE campaign_id = $1::uuid
                AND kind IN ('bo_round', 'ingest_results')
                AND status IN ('in_progress', 'pending', 'completed')
                AND (
                     (ref_table = 'optimization_rounds' AND ref_id = $2::text)
                  OR (ref_table = 'optimization_campaigns' AND ref_id = $3::text)
                )
              RETURNING id::text`,
            [
              camp.synthesis_campaign_id,
              input.round_id,
              camp.campaign_id,
              input.measured_outcomes.length,
              improvedFlag,
            ],
          );
          stepBackfilled = stepUpd.rowCount !== null && stepUpd.rowCount > 0;
          if (stepBackfilled) {
            // Append a measurement_recorded event so the synthesis_campaign_events
            // log has a single auditable record per backfill.
            await client.query(
              `INSERT INTO synthesis_campaign_events (campaign_id, event_type, payload)
               VALUES ($1::uuid, 'measurement_recorded',
                       jsonb_build_object('round_id', $2::text,
                                          'experiments_added', $3::int,
                                          'improved', $4::boolean))`,
              [
                camp.synthesis_campaign_id,
                input.round_id,
                input.measured_outcomes.length,
                improvedFlag,
              ],
            );
          } else {
            log.warn(
              {
                synthesis_campaign_id: camp.synthesis_campaign_id,
                round_id: input.round_id,
                campaign_id: camp.campaign_id,
              },
              "no synthesis_campaign_steps row matched for backfill",
            );
          }
        }

        return { updated: row, improved: improvedFlag, backfilled: stepBackfilled };
      });

      return IngestCampaignResultsOut.parse({
        round_id: input.round_id,
        campaign_id: updated.campaign_id,
        n_outcomes: input.measured_outcomes.length,
        ingested_at: updated.ingested_results_at,
        improved,
        step_backfilled: backfilled,
      });
    },
  });
}
