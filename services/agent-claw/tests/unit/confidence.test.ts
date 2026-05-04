// Tests for the confidence ensemble — Phase C.5 + Tranche 2 / M3.

import { describe, it, expect } from "vitest";
import {
  extractVerbalizedConfidence,
  extractFactIds,
  jaccardSimilarity,
  computeBayesianPosterior,
  composeEnsemble,
  confidenceLabel,
} from "../../src/core/confidence.js";

// ---------------------------------------------------------------------------
// extractVerbalizedConfidence
// ---------------------------------------------------------------------------

describe("extractVerbalizedConfidence", () => {
  it("returns the confidence value from an object with a confidence field", () => {
    expect(extractVerbalizedConfidence({ confidence: 0.82 })).toBe(0.82);
  });

  it("returns 0 for a confidence field equal to 0", () => {
    expect(extractVerbalizedConfidence({ confidence: 0 })).toBe(0);
  });

  it("returns 1 for a confidence field equal to 1", () => {
    expect(extractVerbalizedConfidence({ confidence: 1 })).toBe(1);
  });

  it("returns null for objects without a confidence field", () => {
    expect(extractVerbalizedConfidence({ result: "data" })).toBeNull();
  });

  it("returns null for non-numeric confidence values", () => {
    expect(extractVerbalizedConfidence({ confidence: "high" })).toBeNull();
  });

  it("returns null for null input", () => {
    expect(extractVerbalizedConfidence(null)).toBeNull();
  });

  it("returns null for an array", () => {
    expect(extractVerbalizedConfidence([{ confidence: 0.9 }])).toBeNull();
  });

  it("returns null for out-of-range values (>1)", () => {
    expect(extractVerbalizedConfidence({ confidence: 1.1 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractFactIds
// ---------------------------------------------------------------------------

describe("extractFactIds", () => {
  it("extracts from fact_ids array", () => {
    const ids = extractFactIds({ fact_ids: ["abc", "def"] });
    expect(ids.has("abc")).toBe(true);
    expect(ids.has("def")).toBe(true);
  });

  it("extracts from evidence_fact_ids array", () => {
    const ids = extractFactIds({ evidence_fact_ids: ["efi-123"] });
    expect(ids.has("efi-123")).toBe(true);
  });

  it("extracts source_id from citations array", () => {
    const ids = extractFactIds({
      citations: [{ source_id: "cit-001", source_kind: "kg_fact" }],
    });
    expect(ids.has("cit-001")).toBe(true);
  });

  it("returns empty set for no matching keys", () => {
    expect(extractFactIds({ result: "no ids here" }).size).toBe(0);
  });

  it("returns empty set for null input", () => {
    expect(extractFactIds(null).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity
// ---------------------------------------------------------------------------

describe("jaccardSimilarity", () => {
  it("returns 1.0 for identical sets", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["a", "b", "c"]);
    expect(jaccardSimilarity(a, b)).toBe(1.0);
  });

  it("returns 0 for disjoint sets", () => {
    const a = new Set(["a", "b"]);
    const b = new Set(["c", "d"]);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("returns 0.5 for 50% overlap", () => {
    const a = new Set(["a", "b"]);
    const _b = new Set(["a", "c"]);
    // intersection=1, union=3 → 1/3 is not 0.5. Let's use a, b vs a, b, c:
    // intersection=2, union=3 → 2/3
    const c = new Set(["a", "b", "c"]);
    expect(jaccardSimilarity(a, c)).toBeCloseTo(2 / 3, 5);
  });

  it("returns 1.0 for two empty sets", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// computeBayesianPosterior
// ---------------------------------------------------------------------------

describe("computeBayesianPosterior", () => {
  it("returns mean close to observed rate for large N", () => {
    // 80 successes out of 100 → alpha=81, beta=21 → posterior mean = 81/102 ≈ 0.794
    const result = computeBayesianPosterior({ successes: 80, total: 100 });
    expect(result.mean).toBeCloseTo(0.794, 2);
  });

  it("returns CI that contains the mean", () => {
    const result = computeBayesianPosterior({ successes: 5, total: 10 });
    expect(result.ci_low).toBeLessThanOrEqual(result.mean);
    expect(result.ci_high).toBeGreaterThanOrEqual(result.mean);
  });

  it("returns values in [0,1]", () => {
    const result = computeBayesianPosterior({ successes: 0, total: 5 });
    expect(result.mean).toBeGreaterThanOrEqual(0);
    expect(result.mean).toBeLessThanOrEqual(1);
    expect(result.ci_low).toBeGreaterThanOrEqual(0);
    expect(result.ci_high).toBeLessThanOrEqual(1);
  });

  it("shrinks toward 0.5 for very small N (prior regularization)", () => {
    // 1 success out of 1 → posterior mean = (1+1)/(1+1+0+1) = 2/3 ≠ 1.0
    const result = computeBayesianPosterior({ successes: 1, total: 1 });
    expect(result.mean).toBeLessThan(1.0);
    expect(result.mean).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// composeEnsemble
// ---------------------------------------------------------------------------

describe("composeEnsemble", () => {
  it("returns 0.5 when all signals are null", () => {
    const ens = composeEnsemble({ verbalized: null, cross_model: null, bayesian: null });
    expect(ens.overall).toBe(0.5);
  });

  it("uses only verbalized when other signals are null", () => {
    const ens = composeEnsemble({ verbalized: 0.8, cross_model: null, bayesian: null });
    expect(ens.overall).toBe(0.8);
  });

  it("weights verbalized (0.4), cross_model (0.3), bayesian (0.3) correctly", () => {
    const bayesian = { mean: 0.6, ci_low: 0.4, ci_high: 0.8 };
    const ens = composeEnsemble({ verbalized: 1.0, cross_model: 1.0, bayesian });
    // (1.0*0.4 + 1.0*0.3 + 0.6*0.3) / (0.4+0.3+0.3) = (0.4+0.3+0.18)/1.0 = 0.88
    expect(ens.overall).toBeCloseTo(0.88, 2);
  });

  it("redistributes weight when cross_model is null", () => {
    const bayesian = { mean: 0.6, ci_low: 0.4, ci_high: 0.8 };
    const ens = composeEnsemble({ verbalized: 1.0, cross_model: null, bayesian });
    // (1.0*0.4 + 0.6*0.3) / (0.4+0.3) = 0.58/0.7 ≈ 0.8286
    expect(ens.overall).toBeCloseTo(0.829, 2);
  });

  it("includes brier_estimate when provided", () => {
    const ens = composeEnsemble({
      verbalized: 0.7,
      cross_model: null,
      bayesian: null,
      brier_estimate: 0.12,
    });
    expect(ens.brier_estimate).toBe(0.12);
  });

  it("populates all fields of the output", () => {
    const bayesian = { mean: 0.5, ci_low: 0.3, ci_high: 0.7 };
    const ens = composeEnsemble({ verbalized: 0.8, cross_model: 0.6, bayesian });
    expect(ens.verbalized).toBe(0.8);
    expect(ens.cross_model).toBe(0.6);
    expect(ens.bayesian).toEqual(bayesian);
    expect(typeof ens.overall).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// confidence_label + structured signals (Tranche 2 / M3)
// ---------------------------------------------------------------------------

describe("confidenceLabel", () => {
  it("maps the four bands using the documented thresholds", () => {
    expect(confidenceLabel(1.0)).toBe("foundational");
    expect(confidenceLabel(0.85)).toBe("foundational");
    expect(confidenceLabel(0.84)).toBe("high");
    expect(confidenceLabel(0.65)).toBe("high");
    expect(confidenceLabel(0.64)).toBe("medium");
    expect(confidenceLabel(0.40)).toBe("medium");
    expect(confidenceLabel(0.39)).toBe("low");
    expect(confidenceLabel(0.0)).toBe("low");
  });
});

describe("composeEnsemble — structured signals + label", () => {
  it("emits a categorical confidence_label aligned with overall", () => {
    const ens = composeEnsemble({
      verbalized: 0.95,
      cross_model: 0.9,
      bayesian: { mean: 0.9, ci_low: 0.85, ci_high: 0.95 },
    });
    expect(ens.overall).toBeGreaterThanOrEqual(0.85);
    expect(ens.confidence_label).toBe("foundational");
  });

  it("returns three signals each with name + score + weight + present", () => {
    const ens = composeEnsemble({
      verbalized: 0.7,
      cross_model: null,
      bayesian: { mean: 0.5, ci_low: 0.3, ci_high: 0.7 },
    });
    expect(ens.signals).toHaveLength(3);

    const names = ens.signals.map((s) => s.name).sort();
    expect(names).toEqual(["bayesian", "cross_model", "verbalized"]);

    const verbalized = ens.signals.find((s) => s.name === "verbalized")!;
    expect(verbalized.score).toBe(0.7);
    expect(verbalized.present).toBe(true);
    expect(verbalized.weight).toBe(0.4);

    const cross = ens.signals.find((s) => s.name === "cross_model")!;
    expect(cross.score).toBeNull();
    expect(cross.present).toBe(false);
    expect(cross.weight).toBe(0.3);

    const bayes = ens.signals.find((s) => s.name === "bayesian")!;
    expect(bayes.score).toBe(0.5); // == bayesian.mean
    expect(bayes.present).toBe(true);
    expect(bayes.weight).toBe(0.3);
  });

  it("maps a no-signals ensemble to the medium label (overall=0.5)", () => {
    const ens = composeEnsemble({
      verbalized: null,
      cross_model: null,
      bayesian: null,
    });
    expect(ens.overall).toBe(0.5);
    expect(ens.confidence_label).toBe("medium");
    expect(ens.signals.every((s) => !s.present)).toBe(true);
  });
});
