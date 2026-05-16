"""Unit tests for Phase 1 wave-3 extractors: askcos, ord_io, plate_designer,
chrom_method, bo_round, reaction_optimizer.

Same contract as wave-1 / wave-2: pure functions, no DB / network, must
never raise on malformed input.
"""
from __future__ import annotations

import uuid
from typing import Any

import pytest

from services.projectors.fact_extractor import (
    askcos,
    bo_round,
    chrom_method,
    ord_io,
    plate_designer,
    reaction_optimizer,
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


def _by_predicate(facts: list[FactDraft]) -> dict[str, FactDraft]:
    return {f.predicate: f for f in facts}


# ---------------------------------------------------------------------------
# askcos
# ---------------------------------------------------------------------------


def test_askcos_emits_count_and_score_when_conditions_present():
    result = {
        "conditions": [
            {"score": 0.85, "reagents": ["Pd/C", "H2"]},
            {"score": 0.72, "reagents": ["NaH", "DMF"]},
        ]
    }
    facts = askcos.extract(result, _ctx())
    preds = {f.predicate for f in facts}
    assert preds == {"has_forward_condition_count", "has_top_condition_score"}


def test_askcos_count_is_correct():
    result = {
        "conditions": [
            {"score": 0.85, "reagents": ["A"]},
            {"score": 0.72, "reagents": ["B"]},
            {"score": 0.60, "reagents": ["C"]},
        ]
    }
    by_pred = _by_predicate(askcos.extract(result, _ctx()))
    assert by_pred["has_forward_condition_count"].object_value["value"] == 3


def test_askcos_takes_max_score():
    result = {
        "conditions": [
            {"score": 0.5, "reagents": ["A"]},
            {"score": 0.9, "reagents": ["B"]},
            {"score": 0.7, "reagents": ["C"]},
        ]
    }
    by_pred = _by_predicate(askcos.extract(result, _ctx()))
    assert by_pred["has_top_condition_score"].object_value["value"] == pytest.approx(0.9)


def test_askcos_no_score_field_emits_only_count():
    result = {"conditions": [{"reagents": ["A"]}, {"reagents": ["B"]}]}
    facts = askcos.extract(result, _ctx())
    assert len(facts) == 1
    assert facts[0].predicate == "has_forward_condition_count"


def test_askcos_empty_conditions_returns_empty():
    assert askcos.extract({"conditions": []}, _ctx()) == []


def test_askcos_missing_conditions_returns_empty():
    assert askcos.extract({}, _ctx()) == []


def test_askcos_no_smiles_returns_empty():
    result = {"conditions": [{"score": 0.8, "reagents": ["A"]}]}
    assert askcos.extract(result, _ctx({})) == []


def test_askcos_skips_non_numeric_scores():
    result = {
        "conditions": [
            {"score": "bad", "reagents": ["A"]},
            {"score": 0.75, "reagents": ["B"]},
        ]
    }
    by_pred = _by_predicate(askcos.extract(result, _ctx()))
    assert by_pred["has_top_condition_score"].object_value["value"] == pytest.approx(0.75)


def test_askcos_confidence_and_tier():
    result = {"conditions": [{"score": 0.8}]}
    facts = askcos.extract(result, _ctx())
    assert facts[0].confidence == pytest.approx(0.75)
    assert facts[0].confidence_tier == "high"


# ---------------------------------------------------------------------------
# ord_io
# ---------------------------------------------------------------------------


def test_ord_io_emits_yield_and_temperature():
    result = {
        "reactions": [
            {
                "smiles": "CCO",
                "yield_fraction": 0.82,
                "temperature_c": 80.0,
            }
        ]
    }
    facts = ord_io.extract(result, _ctx({}))
    preds = {f.predicate for f in facts}
    assert preds == {"has_ord_yield_pct", "has_ord_temperature_c"}


def test_ord_io_yield_is_fraction_times_100():
    result = {"reactions": [{"smiles": "CCO", "yield_fraction": 0.75}]}
    by_pred = _by_predicate(ord_io.extract(result, _ctx({})))
    assert by_pred["has_ord_yield_pct"].object_value["value"] == pytest.approx(75.0)
    assert by_pred["has_ord_yield_pct"].unit == "%"


def test_ord_io_temperature_unit():
    result = {"reactions": [{"smiles": "CCO", "temperature_c": 25.0}]}
    by_pred = _by_predicate(ord_io.extract(result, _ctx({})))
    assert by_pred["has_ord_temperature_c"].unit == "°C"


def test_ord_io_only_first_reaction_processed():
    result = {
        "reactions": [
            {"smiles": "CCO", "yield_fraction": 0.80},
            {"smiles": "CCN", "yield_fraction": 0.60},
        ]
    }
    facts = ord_io.extract(result, _ctx({}))
    assert all(f.subject_id_value == "CCO" for f in facts)


def test_ord_io_smiles_falls_back_to_ctx_args():
    result = {"reactions": [{"yield_fraction": 0.70}]}
    facts = ord_io.extract(result, _ctx({"smiles": "CCO"}))
    assert facts[0].subject_id_value == "CCO"


def test_ord_io_invalid_yield_fraction_skipped():
    result = {"reactions": [{"smiles": "CCO", "yield_fraction": 1.5}]}
    assert ord_io.extract(result, _ctx({})) == []


def test_ord_io_empty_reactions_returns_empty():
    assert ord_io.extract({"reactions": []}, _ctx()) == []


def test_ord_io_missing_reactions_returns_empty():
    assert ord_io.extract({}, _ctx()) == []


def test_ord_io_no_smiles_at_all_returns_empty():
    result = {"reactions": [{"yield_fraction": 0.5}]}
    assert ord_io.extract(result, _ctx({})) == []


def test_ord_io_confidence_and_tier():
    result = {"reactions": [{"smiles": "CCO", "yield_fraction": 0.5}]}
    facts = ord_io.extract(result, _ctx({}))
    assert facts[0].confidence == pytest.approx(0.90)
    assert facts[0].confidence_tier == "foundational"


# ---------------------------------------------------------------------------
# plate_designer
# ---------------------------------------------------------------------------


def test_plate_designer_emits_well_count_and_strategy():
    result = {"well_count": 96, "strategy": "randomized_block"}
    facts = plate_designer.extract(result, _ctx({"project_internal_id": "proj-1"}))
    preds = {f.predicate for f in facts}
    assert preds == {"has_plate_well_count", "has_plate_design_strategy"}


def test_plate_designer_well_count_correct():
    result = {"well_count": 384, "strategy": "latin_square"}
    by_pred = _by_predicate(
        plate_designer.extract(result, _ctx({"project_internal_id": "proj-X"}))
    )
    assert by_pred["has_plate_well_count"].object_value["value"] == 384


def test_plate_designer_subject_label_is_nce_project():
    result = {"well_count": 96, "strategy": "grid"}
    facts = plate_designer.extract(result, _ctx({"project_internal_id": "p-1"}))
    assert all(f.subject_label == "NCEProject" for f in facts)
    assert all(f.subject_id_value == "p-1" for f in facts)


def test_plate_designer_project_from_result_fallback():
    result = {"well_count": 96, "strategy": "grid", "project_internal_id": "from-result"}
    facts = plate_designer.extract(result, _ctx({}))
    assert facts[0].subject_id_value == "from-result"


def test_plate_designer_unknown_campaign_fallback():
    result = {"well_count": 96, "strategy": "grid"}
    facts = plate_designer.extract(result, _ctx({}))
    assert facts[0].subject_id_value == "unknown_campaign"


def test_plate_designer_zero_well_count_skipped():
    result = {"well_count": 0, "strategy": "grid"}
    facts = plate_designer.extract(result, _ctx({"project_internal_id": "p-1"}))
    preds = {f.predicate for f in facts}
    assert "has_plate_well_count" not in preds


def test_plate_designer_empty_strategy_skipped():
    result = {"well_count": 96, "strategy": ""}
    facts = plate_designer.extract(result, _ctx({"project_internal_id": "p-1"}))
    preds = {f.predicate for f in facts}
    assert "has_plate_design_strategy" not in preds


def test_plate_designer_empty_result_returns_empty():
    assert plate_designer.extract({}, _ctx()) == []


def test_plate_designer_confidence_and_tier():
    result = {"well_count": 96, "strategy": "grid"}
    facts = plate_designer.extract(result, _ctx({"project_internal_id": "p-1"}))
    assert facts[0].confidence == pytest.approx(0.95)
    assert facts[0].confidence_tier == "foundational"


# ---------------------------------------------------------------------------
# chrom_method
# ---------------------------------------------------------------------------


def test_chrom_method_emits_pareto_size_and_best_resolution():
    result = {
        "pareto_front": [
            {"resolution": 1.5, "gradient_pct": 10.0},
            {"resolution": 1.8, "gradient_pct": 20.0},
        ],
        "best_resolution": 1.8,
    }
    facts = chrom_method.extract(result, _ctx({"project_internal_id": "proj-2"}))
    preds = {f.predicate for f in facts}
    assert preds == {"has_chrom_pareto_front_size", "has_chrom_best_resolution"}


def test_chrom_method_pareto_size_correct():
    result = {
        "pareto_front": [
            {"resolution": 1.5},
            {"resolution": 1.8},
            {"resolution": 2.1},
        ]
    }
    by_pred = _by_predicate(
        chrom_method.extract(result, _ctx({"project_internal_id": "p"}))
    )
    assert by_pred["has_chrom_pareto_front_size"].object_value["value"] == 3


def test_chrom_method_derives_best_resolution_from_pareto_when_absent():
    result = {
        "pareto_front": [
            {"resolution": 1.5},
            {"resolution": 2.2},
            {"resolution": 1.9},
        ]
    }
    by_pred = _by_predicate(
        chrom_method.extract(result, _ctx({"project_internal_id": "p"}))
    )
    assert by_pred["has_chrom_best_resolution"].object_value["value"] == pytest.approx(2.2)


def test_chrom_method_project_id_from_result_fallback():
    result = {
        "pareto_front": [{"resolution": 1.5}],
        "project_internal_id": "from-result",
    }
    facts = chrom_method.extract(result, _ctx({}))
    assert facts[0].subject_id_value == "from-result"


def test_chrom_method_empty_pareto_returns_empty():
    assert chrom_method.extract({"pareto_front": []}, _ctx()) == []


def test_chrom_method_missing_pareto_returns_empty():
    assert chrom_method.extract({}, _ctx()) == []


def test_chrom_method_no_resolution_in_pareto_only_size_emitted():
    result = {"pareto_front": [{"gradient_pct": 10.0}]}
    facts = chrom_method.extract(result, _ctx({"project_internal_id": "p"}))
    preds = {f.predicate for f in facts}
    assert preds == {"has_chrom_pareto_front_size"}
    assert "has_chrom_best_resolution" not in preds


def test_chrom_method_confidence_and_tier():
    result = {"pareto_front": [{"resolution": 1.5}]}
    facts = chrom_method.extract(result, _ctx({"project_internal_id": "p"}))
    assert facts[0].confidence == pytest.approx(0.85)
    assert facts[0].confidence_tier == "foundational"


# ---------------------------------------------------------------------------
# bo_round
# ---------------------------------------------------------------------------


def test_bo_round_recommend_emits_suggestion_count_and_round_index():
    result = {
        "campaign_id": "camp-1",
        "round_index": 3,
        "suggestions": [{"params": {"temp": 80}}, {"params": {"temp": 90}}],
    }
    facts = bo_round.extract(result, _ctx({}))
    preds = {f.predicate for f in facts}
    assert preds == {"has_bo_suggestion_count", "has_bo_round_index"}


def test_bo_round_suggestion_count_correct():
    result = {
        "campaign_id": "camp-1",
        "round_index": 1,
        "suggestions": [{"a": 1}, {"a": 2}, {"a": 3}],
    }
    by_pred = _by_predicate(bo_round.extract(result, _ctx({})))
    assert by_pred["has_bo_suggestion_count"].object_value["value"] == 3


def test_bo_round_recommend_no_round_index_skips_index_fact():
    result = {"campaign_id": "c", "suggestions": [{"a": 1}]}
    facts = bo_round.extract(result, _ctx({}))
    preds = {f.predicate for f in facts}
    assert "has_bo_round_index" not in preds


def test_bo_round_ingest_emits_yield_mean_and_round_index():
    result = {
        "campaign_id": "camp-2",
        "round_index": 2,
        "observations": [
            {"yield_fraction": 0.80},
            {"yield_fraction": 0.60},
        ],
    }
    facts = bo_round.extract(result, _ctx({}))
    preds = {f.predicate for f in facts}
    assert "has_bo_observed_yield_mean_pct" in preds
    assert "has_bo_round_index" in preds


def test_bo_round_yield_mean_computed_correctly():
    result = {
        "campaign_id": "c",
        "round_index": 1,
        "observations": [
            {"yield_fraction": 0.80},
            {"yield_fraction": 0.60},
        ],
    }
    by_pred = _by_predicate(bo_round.extract(result, _ctx({})))
    assert by_pred["has_bo_observed_yield_mean_pct"].object_value["value"] == pytest.approx(70.0)


def test_bo_round_yield_mean_unit_is_percent():
    result = {"campaign_id": "c", "observations": [{"yield_fraction": 0.5}]}
    by_pred = _by_predicate(bo_round.extract(result, _ctx({})))
    assert by_pred["has_bo_observed_yield_mean_pct"].unit == "%"


def test_bo_round_campaign_id_from_ctx_args():
    result = {"suggestions": [{"a": 1}]}
    facts = bo_round.extract(result, _ctx({"campaign_id": "from-args"}))
    assert facts[0].subject_id_value == "from-args"


def test_bo_round_empty_result_returns_empty():
    assert bo_round.extract({}, _ctx({})) == []


def test_bo_round_empty_suggestions_emits_count_zero():
    result = {"campaign_id": "c", "suggestions": []}
    by_pred = _by_predicate(bo_round.extract(result, _ctx({})))
    assert by_pred["has_bo_suggestion_count"].object_value["value"] == 0


def test_bo_round_observations_without_yield_fraction_skips_mean():
    result = {
        "campaign_id": "c",
        "round_index": 1,
        "observations": [{"other_field": 1.0}],
    }
    facts = bo_round.extract(result, _ctx({}))
    preds = {f.predicate for f in facts}
    assert "has_bo_observed_yield_mean_pct" not in preds


def test_bo_round_recommend_confidence_high_tier():
    result = {"campaign_id": "c", "suggestions": [{"a": 1}]}
    facts = bo_round.extract(result, _ctx({}))
    assert facts[0].confidence == pytest.approx(0.80)
    assert facts[0].confidence_tier == "high"


def test_bo_round_ingest_confidence_foundational_tier():
    result = {"campaign_id": "c", "observations": [{"yield_fraction": 0.8}]}
    facts = bo_round.extract(result, _ctx({}))
    assert facts[0].confidence == pytest.approx(0.90)
    assert facts[0].confidence_tier == "foundational"


# ---------------------------------------------------------------------------
# reaction_optimizer
# ---------------------------------------------------------------------------


def test_reaction_optimizer_emits_objective_count():
    result = {"campaign_id": "camp-3", "objective_count": 2}
    facts = reaction_optimizer.extract(result, _ctx({}))
    preds = {f.predicate for f in facts}
    assert "has_optimization_objective_count" in preds


def test_reaction_optimizer_emits_pareto_size_and_best_yield():
    result = {"campaign_id": "camp-4", "pareto_size": 5, "best_yield_pct": 87.5}
    facts = reaction_optimizer.extract(result, _ctx({}))
    preds = {f.predicate for f in facts}
    assert preds == {"has_pareto_front_size", "has_pareto_best_yield_pct"}


def test_reaction_optimizer_objective_count_correct():
    result = {"campaign_id": "c", "objective_count": 3}
    by_pred = _by_predicate(reaction_optimizer.extract(result, _ctx({})))
    assert by_pred["has_optimization_objective_count"].object_value["value"] == 3


def test_reaction_optimizer_best_yield_pct_correct():
    result = {"campaign_id": "c", "pareto_size": 4, "best_yield_pct": 92.0}
    by_pred = _by_predicate(reaction_optimizer.extract(result, _ctx({})))
    assert by_pred["has_pareto_best_yield_pct"].object_value["value"] == pytest.approx(92.0)
    assert by_pred["has_pareto_best_yield_pct"].unit == "%"


def test_reaction_optimizer_campaign_id_from_ctx_args():
    result = {"objective_count": 1}
    facts = reaction_optimizer.extract(result, _ctx({"campaign_id": "from-args"}))
    assert facts[0].subject_id_value == "from-args"


def test_reaction_optimizer_zero_objective_count_skipped():
    result = {"campaign_id": "c", "objective_count": 0}
    assert reaction_optimizer.extract(result, _ctx({})) == []


def test_reaction_optimizer_subject_label_is_optimization_campaign():
    result = {"campaign_id": "c", "objective_count": 2}
    facts = reaction_optimizer.extract(result, _ctx({}))
    assert all(f.subject_label == "OptimizationCampaign" for f in facts)


def test_reaction_optimizer_empty_result_returns_empty():
    assert reaction_optimizer.extract({}, _ctx({})) == []


def test_reaction_optimizer_confidence_and_tier():
    result = {"campaign_id": "c", "objective_count": 1}
    facts = reaction_optimizer.extract(result, _ctx({}))
    assert facts[0].confidence == pytest.approx(0.90)
    assert facts[0].confidence_tier == "foundational"


# ---------------------------------------------------------------------------
# Defensive — every extractor swallows arbitrary garbage
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "extractor",
    [
        askcos.extract,
        ord_io.extract,
        plate_designer.extract,
        chrom_method.extract,
        bo_round.extract,
        reaction_optimizer.extract,
    ],
)
def test_extractor_swallows_garbage_result(extractor):
    """Top-level extract() must return [] on any kind of garbage rather than raise."""
    assert extractor({}, _ctx()) == []
    assert extractor({"unrelated": "noise"}, _ctx()) == []
    assert extractor({"conditions": "not a list"}, _ctx()) == []
    assert extractor({"reactions": 123}, _ctx()) == []
    assert extractor({"pareto_front": {"not": "a list"}}, _ctx()) == []
    assert extractor({"suggestions": "nope"}, _ctx()) == []
    assert extractor(None, _ctx()) == []  # type: ignore[arg-type]
