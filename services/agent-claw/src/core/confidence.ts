// Confidence ensemble — Phase C.5
//
// Three signals composed into a single confidence_ensemble JSONB value.
//
// Signal 1 — verbalized self-uncertainty:
//   Read from any tool output that carries a numeric `confidence` field (0–1).
//   Generalised from propose_hypothesis to all structured tool outputs.
//
// Signal 2 — cross-model agreement (off by default):
//   Sample the same query at temperature 0 from a second model and compute
//   Jaccard on surfaced fact_ids. Configurable via `crossModel: true`.
//
// Signal 3 — Bayesian posterior:
//   If KG has prior counts for the predicate, compute Beta-Binomial posterior
//   and report mean + 90% CI. Returns null if no prior available.
//
// Output: ConfidenceEnsemble JSONB shape stored in artifacts.confidence_ensemble.

import { getLogger } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BayesianPosterior {
  mean: number;
  ci_low: number;
  ci_high: number;
}

export interface ConfidenceEnsemble {
  /** LLM's own verbalized confidence (0–1), or null if the output had none. */
  verbalized: number | null;
  /** Jaccard similarity of fact_ids between two model samples (0–1). Off by default. */
  cross_model: number | null;
  /** Beta-Binomial posterior from KG priors, or null if no priors. */
  bayesian: BayesianPosterior | null;
  /** Weighted overall score (0–1). */
  overall: number;
  /**
   * Categorical label derived from `overall` so the LLM can reason about
   * the confidence directly without re-deriving thresholds:
   *   - 'foundational' (≥ 0.85): cite confidently, suitable for FOUNDATION outputs.
   *   - 'high'         (≥ 0.65): supportable, defaults to WORKING tier.
   *   - 'medium'       (≥ 0.40): exploratory, hedge.
   *   - 'low'          (<  0.40): treat as a working hypothesis, not a claim.
   * Tranche 2 / M3.
   */
  confidence_label: ConfidenceLabel;
  /**
   * Structured per-signal record. Same data as the top-level fields, but
   * shaped so a downstream renderer (or the LLM) can iterate and surface
   * each signal independently — replaces "flatten into prose" reads where
   * the agent loses the per-signal provenance. Tranche 2 / M3.
   */
  signals: ConfidenceSignal[];
  /** Estimated Brier score if calibration data is available. */
  brier_estimate?: number;
}

export type ConfidenceLabel = "foundational" | "high" | "medium" | "low";

export interface ConfidenceSignal {
  /** Human-readable signal name. */
  name: "verbalized" | "cross_model" | "bayesian";
  /** Numeric score on the [0,1] axis used by the ensemble, or null when unavailable. */
  score: number | null;
  /** Weight applied in the ensemble composition. */
  weight: number;
  /** Whether this signal contributed to the `overall` value. */
  present: boolean;
}

/**
 * Map a numeric ensemble score to its categorical confidence label.
 *
 * Thresholds chosen so the label aligns with the maturity tier convention
 * (FOUNDATION / WORKING / EXPLORATORY): an ensemble in the foundational
 * band should be safe to cite as a FOUNDATION artifact; the medium / low
 * bands map to EXPLORATORY where the agent should hedge.
 */
export function confidenceLabel(overall: number): ConfidenceLabel {
  if (overall >= 0.85) return "foundational";
  if (overall >= 0.65) return "high";
  if (overall >= 0.40) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Signal 1: Verbalized self-uncertainty
// ---------------------------------------------------------------------------

/**
 * Extract verbalized confidence from a tool output object.
 * Returns the numeric value [0,1] if found, or null.
 */
export function extractVerbalizedConfidence(output: unknown): number | null {
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return null;
  }
  const obj = output as Record<string, unknown>;
  const val = obj.confidence;
  if (typeof val === "number" && val >= 0 && val <= 1) {
    return val;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Signal 2: Cross-model agreement — Phase D.2 real implementation
// ---------------------------------------------------------------------------

/**
 * Cross-model agreement check using the 'judge' role (Haiku-class).
 *
 * Sends the answer text to the judge model at temperature 0 and asks it to
 * rate how well-grounded / internally consistent the answer is on a 0-1 scale.
 * Returns the numeric agreement score.
 *
 * Gate: only called when `AGENT_CONFIDENCE_CROSS_MODEL=true` (off by default).
 *
 * @param text - The answer text to evaluate (typically the assistant's last response).
 * @param llm  - LlmProvider used for the judge call.
 * @returns agreement score [0,1] or null on failure.
 */
export async function crossModelAgreement(
  text: string,
  llm: CrossModelLlmProvider,
): Promise<number | null> {
  try {
    const result = await llm.completeJson({
      system:
        "You are a scientific accuracy judge. Rate the internal consistency " +
        "and factual grounding of the provided answer on a scale from 0 to 1. " +
        "0 means highly inconsistent or fabricated; 1 means well-grounded and consistent. " +
        'Return ONLY valid JSON: {"agreement": <number between 0 and 1>}',
      user: `Answer to evaluate:\n${text.slice(0, 2_000)}`,
      role: "judge",
    });

    if (
      result !== null &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      typeof (result as Record<string, unknown>).agreement === "number"
    ) {
      const score = (result as Record<string, unknown>).agreement as number;
      if (score >= 0 && score <= 1) return Math.round(score * 1000) / 1000;
    }
    return null;
  } catch (err) {
    // Surface the failure so operators see when judge calls degrade —
    // a silent null was indistinguishable from "judge agreed at null"
    // and hid LiteLLM outages, model rate-limits, or JSON-parse
    // breakage from the dashboard.
    getLogger("agent-claw.confidence").warn(
      {
        event: "cross_model_agreement_failed",
        err_name: (err as Error).name,
        err_msg: (err as Error).message,
      },
      "cross-model agreement check failed; returning null",
    );
    return null;
  }
}

/** Minimal interface the cross-model checker requires from the LLM provider. */
export interface CrossModelLlmProvider {
  completeJson(opts: { system: string; user: string; role?: "judge" }): Promise<unknown>;
}

/**
 * Extract fact_ids from a tool output (top-level `fact_ids` array or
 * `citations` array with `source_id` keys).
 */
export function extractFactIds(output: unknown): Set<string> {
  const ids = new Set<string>();
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return ids;
  }
  const obj = output as Record<string, unknown>;

  // Direct fact_ids array.
  if (Array.isArray(obj.fact_ids)) {
    for (const id of obj.fact_ids as unknown[]) {
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }

  // evidence_fact_ids (synthesize_insights pattern).
  if (Array.isArray(obj.evidence_fact_ids)) {
    for (const id of obj.evidence_fact_ids as unknown[]) {
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }

  // cited_fact_ids (propose_hypothesis pattern).
  if (Array.isArray(obj.cited_fact_ids)) {
    for (const id of obj.cited_fact_ids as unknown[]) {
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }

  // citations array (Citation type — read source_id).
  if (Array.isArray(obj.citations)) {
    for (const c of obj.citations as unknown[]) {
      if (c && typeof c === "object" && !Array.isArray(c)) {
        const cObj = c as Record<string, unknown>;
        if (typeof cObj.source_id === "string" && cObj.source_id.length > 0) {
          ids.add(cObj.source_id);
        }
      }
    }
  }

  return ids;
}

/**
 * Compute Jaccard similarity between two sets.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  let intersection = 0;
  for (const id of a) {
    if (b.has(id)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Signal 3: Bayesian posterior (Beta-Binomial)
// ---------------------------------------------------------------------------

export interface KgPriorCounts {
  /** Number of times this predicate yielded the asserted outcome. */
  successes: number;
  /** Total observations for this predicate. */
  total: number;
}

/**
 * Compute Beta-Binomial posterior using uniform Beta(1,1) prior.
 * Returns mean and 90% credible interval via Beta distribution approximation.
 *
 * With Beta(alpha, beta):
 *   alpha = successes + 1
 *   beta  = failures + 1
 *   mean  = alpha / (alpha + beta)
 *   90% CI approximated using Wilson score interval.
 */
export function computeBayesianPosterior(
  prior: KgPriorCounts,
): BayesianPosterior {
  const alpha = prior.successes + 1;
  const beta = prior.total - prior.successes + 1;
  const mean = alpha / (alpha + beta);

  // Wilson score interval at 90% confidence (z = 1.645).
  const z = 1.645;
  const n = prior.total + 2; // effective sample size with uniform prior
  const p = mean;
  const center = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);

  return {
    mean: Math.round(mean * 1000) / 1000,
    ci_low: Math.max(0, Math.round((center - margin) * 1000) / 1000),
    ci_high: Math.min(1, Math.round((center + margin) * 1000) / 1000),
  };
}

// ---------------------------------------------------------------------------
// Ensemble composition
// ---------------------------------------------------------------------------

/**
 * Compose the three signals into a ConfidenceEnsemble.
 *
 * Weighting (equal by default; Phase E will calibrate):
 *   verbalized  → weight 0.4
 *   cross_model → weight 0.3 (skipped if null — weight redistributed)
 *   bayesian    → weight 0.3 (skipped if null — weight redistributed)
 */
export function composeEnsemble(opts: {
  verbalized: number | null;
  cross_model: number | null;
  bayesian: BayesianPosterior | null;
  brier_estimate?: number;
}): ConfidenceEnsemble {
  const VERBALIZED_WEIGHT = 0.4;
  const CROSS_MODEL_WEIGHT = 0.3;
  const BAYESIAN_WEIGHT = 0.3;

  const weighted: Array<[number, number]> = []; // [value, weight]
  if (opts.verbalized !== null) weighted.push([opts.verbalized, VERBALIZED_WEIGHT]);
  if (opts.cross_model !== null) weighted.push([opts.cross_model, CROSS_MODEL_WEIGHT]);
  if (opts.bayesian !== null) weighted.push([opts.bayesian.mean, BAYESIAN_WEIGHT]);

  let overall: number;
  if (weighted.length === 0) {
    overall = 0.5; // no signals → mid-range neutral
  } else {
    const totalWeight = weighted.reduce((s, [, w]) => s + w, 0);
    const weightedSum = weighted.reduce((s, [v, w]) => s + v * w, 0);
    overall = weightedSum / totalWeight;
  }

  const roundedOverall = Math.round(overall * 1000) / 1000;

  // Tranche 2 / M3: structured per-signal record so the LLM can reason about
  // each signal independently rather than seeing flat JSON.
  const signals: ConfidenceSignal[] = [
    {
      name: "verbalized",
      score: opts.verbalized,
      weight: VERBALIZED_WEIGHT,
      present: opts.verbalized !== null,
    },
    {
      name: "cross_model",
      score: opts.cross_model,
      weight: CROSS_MODEL_WEIGHT,
      present: opts.cross_model !== null,
    },
    {
      name: "bayesian",
      score: opts.bayesian?.mean ?? null,
      weight: BAYESIAN_WEIGHT,
      present: opts.bayesian !== null,
    },
  ];

  return {
    verbalized: opts.verbalized,
    cross_model: opts.cross_model,
    bayesian: opts.bayesian,
    overall: roundedOverall,
    confidence_label: confidenceLabel(roundedOverall),
    signals,
    brier_estimate: opts.brier_estimate,
  };
}
