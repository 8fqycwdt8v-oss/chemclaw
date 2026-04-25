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
  /** Estimated Brier score if calibration data is available. */
  brier_estimate?: number;
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
  const val = obj["confidence"];
  if (typeof val === "number" && val >= 0 && val <= 1) {
    return val;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Signal 2: Cross-model agreement
// ---------------------------------------------------------------------------

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
  if (Array.isArray(obj["fact_ids"])) {
    for (const id of obj["fact_ids"] as unknown[]) {
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }

  // evidence_fact_ids (synthesize_insights pattern).
  if (Array.isArray(obj["evidence_fact_ids"])) {
    for (const id of obj["evidence_fact_ids"] as unknown[]) {
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }

  // cited_fact_ids (propose_hypothesis pattern).
  if (Array.isArray(obj["cited_fact_ids"])) {
    for (const id of obj["cited_fact_ids"] as unknown[]) {
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }

  // citations array (Citation type — read source_id).
  if (Array.isArray(obj["citations"])) {
    for (const c of obj["citations"] as unknown[]) {
      if (c && typeof c === "object" && !Array.isArray(c)) {
        const cObj = c as Record<string, unknown>;
        if (typeof cObj["source_id"] === "string" && cObj["source_id"].length > 0) {
          ids.add(cObj["source_id"]);
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
  const signals: Array<[number, number]> = []; // [value, weight]

  if (opts.verbalized !== null) signals.push([opts.verbalized, 0.4]);
  if (opts.cross_model !== null) signals.push([opts.cross_model, 0.3]);
  if (opts.bayesian !== null) signals.push([opts.bayesian.mean, 0.3]);

  let overall: number;
  if (signals.length === 0) {
    overall = 0.5; // no signals → mid-range neutral
  } else {
    const totalWeight = signals.reduce((s, [, w]) => s + w, 0);
    const weightedSum = signals.reduce((s, [v, w]) => s + v * w, 0);
    overall = weightedSum / totalWeight;
  }

  return {
    verbalized: opts.verbalized,
    cross_model: opts.cross_model,
    bayesian: opts.bayesian,
    overall: Math.round(overall * 1000) / 1000,
    brier_estimate: opts.brier_estimate,
  };
}
