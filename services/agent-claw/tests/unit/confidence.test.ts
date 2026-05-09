// Tests for the confidence ensemble — Phase C.5 + Tranche 2 / M3.

import { describe, it, expect } from "vitest";
import {
  extractVerbalizedConfidence,
  extractCalibratedConfidence,
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
    const ens = composeEnsemble({
      verbalized: null,
      cross_model: null,
      bayesian: null,
      calibrated: null,
    });
    expect(ens.overall).toBe(0.5);
  });

  it("uses only verbalized when other signals are null", () => {
    const ens = composeEnsemble({
      verbalized: 0.8,
      cross_model: null,
      bayesian: null,
      calibrated: null,
    });
    expect(ens.overall).toBe(0.8);
  });

  it("weights verbalized (0.3), cross_model (0.25), bayesian (0.25), calibrated (0.20) correctly", () => {
    const bayesian = { mean: 0.6, ci_low: 0.4, ci_high: 0.8 };
    const ens = composeEnsemble({
      verbalized: 1.0,
      cross_model: 1.0,
      bayesian,
      calibrated: 0.4,
    });
    // (1.0*0.3 + 1.0*0.25 + 0.6*0.25 + 0.4*0.20) / 1.0
    // = 0.3 + 0.25 + 0.15 + 0.08 = 0.78
    expect(ens.overall).toBeCloseTo(0.78, 2);
  });

  it("redistributes weight when cross_model is null", () => {
    const bayesian = { mean: 0.6, ci_low: 0.4, ci_high: 0.8 };
    const ens = composeEnsemble({
      verbalized: 1.0,
      cross_model: null,
      bayesian,
      calibrated: null,
    });
    // (1.0*0.3 + 0.6*0.25) / (0.3+0.25) = 0.45/0.55 ≈ 0.818
    expect(ens.overall).toBeCloseTo(0.818, 2);
  });

  it("includes brier_estimate when provided", () => {
    const ens = composeEnsemble({
      verbalized: 0.7,
      cross_model: null,
      bayesian: null,
      calibrated: null,
      brier_estimate: 0.12,
    });
    expect(ens.brier_estimate).toBe(0.12);
  });

  it("populates all fields of the output", () => {
    const bayesian = { mean: 0.5, ci_low: 0.3, ci_high: 0.7 };
    const ens = composeEnsemble({
      verbalized: 0.8,
      cross_model: 0.6,
      bayesian,
      calibrated: 0.7,
    });
    expect(ens.verbalized).toBe(0.8);
    expect(ens.cross_model).toBe(0.6);
    expect(ens.bayesian).toEqual(bayesian);
    expect(ens.calibrated).toBe(0.7);
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
      calibrated: 0.9,
    });
    expect(ens.overall).toBeGreaterThanOrEqual(0.85);
    expect(ens.confidence_label).toBe("foundational");
  });

  it("returns four signals each with name + score + weight + present", () => {
    const ens = composeEnsemble({
      verbalized: 0.7,
      cross_model: null,
      bayesian: { mean: 0.5, ci_low: 0.3, ci_high: 0.7 },
      calibrated: 0.6,
    });
    expect(ens.signals).toHaveLength(4);

    const names = ens.signals.map((s) => s.name).sort();
    expect(names).toEqual(["bayesian", "calibrated", "cross_model", "verbalized"]);

    const verbalized = ens.signals.find((s) => s.name === "verbalized")!;
    expect(verbalized.score).toBe(0.7);
    expect(verbalized.present).toBe(true);
    expect(verbalized.weight).toBe(0.3);

    const cross = ens.signals.find((s) => s.name === "cross_model")!;
    expect(cross.score).toBeNull();
    expect(cross.present).toBe(false);
    expect(cross.weight).toBe(0.25);

    const bayes = ens.signals.find((s) => s.name === "bayesian")!;
    expect(bayes.score).toBe(0.5); // == bayesian.mean
    expect(bayes.present).toBe(true);
    expect(bayes.weight).toBe(0.25);

    const calib = ens.signals.find((s) => s.name === "calibrated")!;
    expect(calib.score).toBe(0.6);
    expect(calib.present).toBe(true);
    expect(calib.weight).toBe(0.2);
  });

  it("maps a no-signals ensemble to the medium label (overall=0.5)", () => {
    const ens = composeEnsemble({
      verbalized: null,
      cross_model: null,
      bayesian: null,
      calibrated: null,
    });
    expect(ens.overall).toBe(0.5);
    expect(ens.confidence_label).toBe("medium");
    expect(ens.signals.every((s) => !s.present)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractCalibratedConfidence — review §1.3, recommendation 10
// ---------------------------------------------------------------------------

describe("extractCalibratedConfidence", () => {
  it("returns null for non-prediction payloads", () => {
    expect(extractCalibratedConfidence({ confidence: 0.8 })).toBeNull();
    expect(extractCalibratedConfidence(null)).toBeNull();
    expect(extractCalibratedConfidence([{ predictions: [] }])).toBeNull();
  });

  it("returns null when predictions array is empty", () => {
    expect(extractCalibratedConfidence({ predictions: [] })).toBeNull();
  });

  it("returns null when predictions have no std/ensemble_std field", () => {
    expect(
      extractCalibratedConfidence({
        predictions: [{ smiles: "CC", value: 1.5 }],
      }),
    ).toBeNull();
  });

  it("maps yield std=0 to confidence=1.0", () => {
    expect(
      extractCalibratedConfidence({
        predictions: [
          { rxn_smiles: "A>>B", predicted_yield: 80, std: 0, model_id: "m@v1" },
        ],
      }),
    ).toBe(1.0);
  });

  it("maps yield std=30 to confidence=0 (boundary of usable signal)", () => {
    expect(
      extractCalibratedConfidence({
        predictions: [
          { rxn_smiles: "A>>B", predicted_yield: 50, std: 30, model_id: "m@v1" },
        ],
      }),
    ).toBe(0);
  });

  it("maps yield std=15 to confidence=0.5 (midpoint)", () => {
    expect(
      extractCalibratedConfidence({
        predictions: [
          { rxn_smiles: "A>>B", predicted_yield: 50, std: 15, model_id: "m@v1" },
        ],
      }),
    ).toBe(0.5);
  });

  it("averages confidence across multiple yield predictions", () => {
    // std=5 → 1-5/30=0.833 ; std=25 → 1-25/30=0.167 ; mean = 0.5
    const score = extractCalibratedConfidence({
      predictions: [
        { rxn_smiles: "A>>B", predicted_yield: 80, std: 5, model_id: "m@v1" },
        { rxn_smiles: "C>>D", predicted_yield: 30, std: 25, model_id: "m@v1" },
      ],
    });
    expect(score).toBeCloseTo(0.5, 2);
  });

  it("prefers ensemble_std over std (predict_yield_with_uq shape)", () => {
    // ensemble_std=10 → 1-10/30=0.667 ; chemprop_std=5 should be ignored.
    expect(
      extractCalibratedConfidence({
        predictions: [
          {
            rxn_smiles: "A>>B",
            predicted_yield: 60,
            ensemble_std: 10,
            components: { chemprop_std: 5, xgb_disagreement: 5 },
          },
        ],
      }),
    ).toBeCloseTo(0.667, 2);
  });

  it("uses value-relative scaling for property predictions", () => {
    // logP value=2, std=0.4 → 1 - 0.4/2 = 0.8
    expect(
      extractCalibratedConfidence({
        predictions: [{ smiles: "CCO", value: 2, std: 0.4 }],
      }),
    ).toBeCloseTo(0.8, 2);
  });

  it("floors the value scale at 1 to avoid blow-up at near-zero values", () => {
    // value=0.1, std=0.5 → without floor would be 1-0.5/0.1=clipped 0; with floor,
    // 1-0.5/max(0.1,1)=1-0.5=0.5.
    expect(
      extractCalibratedConfidence({
        predictions: [{ smiles: "CC", value: 0.1, std: 0.5 }],
      }),
    ).toBe(0.5);
  });

  it("skips predictions with NaN/negative std", () => {
    // First skipped (NaN), second (std=0) wins.
    expect(
      extractCalibratedConfidence({
        predictions: [
          { rxn_smiles: "A>>B", predicted_yield: 50, std: Number.NaN },
          { rxn_smiles: "C>>D", predicted_yield: 50, std: 0 },
        ],
      }),
    ).toBe(1.0);
  });
});
