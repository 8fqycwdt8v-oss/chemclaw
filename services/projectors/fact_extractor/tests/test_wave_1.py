"""Unit tests for Phase 1.2 wave-1 extractors: aizynth, chemprop,
applicability_domain, yield_baseline.

Same contract as xtb (test_xtb.py): pure functions, no DB / network,
must never raise on malformed input.
"""
from __future__ import annotations

import uuid
from typing import Any

import pytest

from services.projectors.fact_extractor import (
    aizynth,
    applicability_domain,
    chemprop,
    yield_baseline,
)
from services.projectors.tool_result_extractor.main import (
    ExtractionContext,
    FactDraft,
)


def _ctx(args: dict[str, Any] | None = None) -> ExtractionContext:
    resolved_args = {"smiles": "CCO"} if args is None else args
    return ExtractionContext(
        tool_name="test_tool",
        user_entra_id="test-user",
        project_id=str(uuid.uuid4()),
        args=resolved_args,
        invocation_id=str(uuid.uuid4()),
        duration_ms=1234,
    )


# ---------------------------------------------------------------------------
# aizynth
# ---------------------------------------------------------------------------


def test_aizynth_emits_three_facts_when_routes_present():
    result = {
        "routes": [
            {"score": 1.5, "in_stock_ratio": 0.8, "tree": {}},
            {"score": 1.2, "in_stock_ratio": 0.6, "tree": {}},
        ]
    }
    facts = aizynth.extract(result, _ctx())
    preds = {f.predicate for f in facts}
    assert preds == {
        "has_retrosynthesis_route_count",
        "has_top_retrosynthesis_score",
        "has_top_in_stock_ratio",
    }


def test_aizynth_takes_max_score_and_ratio():
    facts = aizynth.extract(
        {"routes": [{"score": 0.5, "in_stock_ratio": 0.3}, {"score": 2.0, "in_stock_ratio": 0.9}]},
        _ctx(),
    )
    by_pred = {f.predicate: f.object_value["value"] for f in facts}
    assert by_pred["has_top_retrosynthesis_score"] == 2.0
    assert by_pred["has_top_in_stock_ratio"] == 0.9


def test_aizynth_empty_routes_returns_empty():
    assert aizynth.extract({"routes": []}, _ctx()) == []


def test_aizynth_no_smiles_returns_empty():
    assert (
        aizynth.extract({"routes": [{"score": 1.0, "in_stock_ratio": 0.5}]}, _ctx({}))
        == []
    )


def test_aizynth_swallows_bad_route_entries():
    """Non-dict / missing-field entries should be skipped, not raise."""
    result = {
        "routes": [
            "not a dict",
            {"score": 1.5, "in_stock_ratio": 0.8},
            {"no_fields": True},
        ]
    }
    facts = aizynth.extract(result, _ctx())
    # 3 facts (count, score, ratio) from the one good route.
    assert len(facts) == 3


# ---------------------------------------------------------------------------
# chemprop
# ---------------------------------------------------------------------------


def test_chemprop_yield_predictions():
    result = {
        "predictions": [
            {"rxn_smiles": "A>>B", "predicted_yield": 75.0, "std": 5.0, "model_id": "m1"},
            {"rxn_smiles": "C>>D", "predicted_yield": 60.0, "std": 10.0, "model_id": "m1"},
        ]
    }
    facts = chemprop.extract(result, _ctx())
    assert len(facts) == 2
    assert all(f.predicate == "has_predicted_yield_pct" for f in facts)
    assert all(f.subject_label == "Reaction" for f in facts)
    # First prediction: std/value = 5/75 ≈ 0.067 → base confidence (0.80,
    # high tier since 0.65 ≤ 0.80 < 0.85)
    assert facts[0].confidence == 0.80
    assert facts[0].confidence_tier == "high"


def test_chemprop_high_std_drops_to_medium_tier():
    result = {
        "predictions": [
            {"rxn_smiles": "A>>B", "predicted_yield": 50.0, "std": 18.0},  # rel = 0.36
        ]
    }
    facts = chemprop.extract(result, _ctx())
    assert len(facts) == 1
    assert facts[0].confidence == 0.65
    assert facts[0].confidence_tier == "high"


def test_chemprop_property_predictions_with_property_name():
    result = {
        "predictions": [
            {"smiles": "CCO", "value": -0.5, "std": 0.05},
            {"smiles": "CCC", "value": 1.2, "std": 0.1},
        ]
    }
    facts = chemprop.extract(result, _ctx({"property": "logP"}))
    assert len(facts) == 2
    assert all(f.predicate == "has_predicted_logP" for f in facts)
    assert all(f.subject_label == "Compound" for f in facts)


def test_chemprop_property_falls_back_to_generic_predicate_without_property():
    result = {"predictions": [{"smiles": "CCO", "value": 1.0, "std": 0.1}]}
    facts = chemprop.extract(result, _ctx({"smiles": "CCO"}))  # no `property` key
    assert facts[0].predicate == "has_predicted_property_value"


def test_chemprop_empty_predictions_returns_empty():
    assert chemprop.extract({"predictions": []}, _ctx()) == []


def test_chemprop_unknown_shape_returns_empty():
    """If predictions don't match yield OR property shape, no-op."""
    result = {"predictions": [{"unknown_field": 1}]}
    assert chemprop.extract(result, _ctx()) == []


# ---------------------------------------------------------------------------
# applicability_domain
# ---------------------------------------------------------------------------


def test_applicability_verdict_for_compound():
    result = {
        "verdict": "in_domain",
        "tanimoto_signal": {"score": 0.78},
        "mahalanobis_signal": {"score": 1.2},
        "conformal_signal": None,
        "used_global_fallback": False,
    }
    facts = applicability_domain.extract(
        result, _ctx({"query_smiles": "CCO"})
    )
    preds = {f.predicate for f in facts}
    # Verdict fact + tanimoto + mahalanobis signal facts. Conformal is None.
    assert "has_applicability_verdict" in preds
    assert "has_applicability_tanimoto_signal" in preds
    assert "has_applicability_mahalanobis_signal" in preds
    assert "has_applicability_conformal_signal" not in preds


def test_applicability_verdict_for_reaction_prefers_rxn_smiles():
    facts = applicability_domain.extract(
        {"verdict": "out_of_domain"},
        _ctx({"rxn_smiles": "A>>B"}),
    )
    assert facts[0].subject_label == "Reaction"
    assert facts[0].subject_id_value == "A>>B"


def test_applicability_no_verdict_returns_empty():
    assert applicability_domain.extract({"verdict": ""}, _ctx()) == []
    assert applicability_domain.extract({}, _ctx()) == []


def test_applicability_no_subject_returns_empty():
    """Without any SMILES we can't anchor the verdict."""
    facts = applicability_domain.extract(
        {"verdict": "in_domain"},
        _ctx({}),
    )
    assert facts == []


def test_applicability_records_fallback_flag():
    facts = applicability_domain.extract(
        {"verdict": "in_domain", "used_global_fallback": True},
        _ctx({"query_smiles": "CCO"}),
    )
    assert facts[0].object_value["used_global_fallback"] is True


# ---------------------------------------------------------------------------
# yield_baseline
# ---------------------------------------------------------------------------


def test_yield_baseline_emits_model_fact():
    result = {"model_id": "yb-001", "n_train": 50, "cached_for_seconds": 3600}
    facts = yield_baseline.extract(
        result, _ctx({"project_internal_id": "proj-1"})
    )
    assert len(facts) == 1
    f = facts[0]
    assert f.subject_label == "Project"
    assert f.subject_id_value == "proj-1"
    assert f.predicate == "has_yield_baseline_model"
    assert f.object_value["value"] == "yb-001"
    assert f.object_value["n_train"] == 50


def test_yield_baseline_falls_back_to_ctx_project():
    ctx = _ctx({})
    ctx_project = ctx.project_id
    assert ctx_project is not None
    facts = yield_baseline.extract({"model_id": "yb-002"}, ctx)
    assert len(facts) == 1
    assert facts[0].subject_id_value == ctx_project


def test_yield_baseline_no_model_returns_empty():
    assert yield_baseline.extract({}, _ctx()) == []
    assert yield_baseline.extract({"model_id": ""}, _ctx()) == []


def test_yield_baseline_no_project_returns_empty():
    ctx = ExtractionContext(
        tool_name="t",
        user_entra_id="u",
        project_id=None,
        args={},
        invocation_id="i",
        duration_ms=0,
    )
    assert yield_baseline.extract({"model_id": "yb-001"}, ctx) == []


# ---------------------------------------------------------------------------
# Defensive — every extractor swallows arbitrary garbage
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "extractor",
    [aizynth.extract, chemprop.extract, applicability_domain.extract, yield_baseline.extract],
)
def test_extractor_swallows_garbage_result(extractor):
    # Top-level extract() must return [] on any kind of garbage rather than raise.
    assert extractor({}, _ctx()) == []
    assert extractor({"unrelated": "noise"}, _ctx()) == []
