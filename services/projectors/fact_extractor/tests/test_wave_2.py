"""Unit tests for Phase 1.2 wave-2 extractors: sirius, crest, synthegy,
tabicl, genchem.

Same contract as wave-1: pure functions, no DB / network, must never raise
on malformed input.
"""
from __future__ import annotations

import uuid
from typing import Any

import pytest

from services.projectors.fact_extractor import (
    crest,
    genchem,
    sirius,
    synthegy,
    tabicl,
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
# sirius
# ---------------------------------------------------------------------------


def test_sirius_emits_one_fact_per_candidate():
    result = {
        "candidates": [
            {"smiles": "CCO", "name": "ethanol", "score": 0.92, "classyfire": {}},
            {"smiles": "CCN", "name": "ethylamine", "score": 0.81, "classyfire": {}},
        ]
    }
    facts = sirius.extract(result, _ctx({"precursor_mz": 46.04, "ionization": "positive"}))
    assert len(facts) == 2
    assert all(f.predicate == "has_sirius_structure_score" for f in facts)
    assert all(f.subject_label == "Compound" for f in facts)
    # Subject ids are the candidate SMILES (not the input — sirius takes MS data).
    assert {f.subject_id_value for f in facts} == {"CCO", "CCN"}


def test_sirius_records_precursor_and_rank_in_object_value():
    result = {"candidates": [{"smiles": "CCO", "name": "ethanol", "score": 0.9, "classyfire": {}}]}
    facts = sirius.extract(result, _ctx({"precursor_mz": 46.04, "ionization": "positive"}))
    assert facts[0].object_value["precursor_mz"] == 46.04
    assert facts[0].object_value["ionization"] == "positive"
    assert facts[0].object_value["rank"] == 1


def test_sirius_caps_at_top_5_candidates():
    """A 100-candidate response should produce at most 5 facts to avoid KG flooding."""
    candidates = [
        {"smiles": f"C{'C' * i}O", "name": f"c{i}", "score": 1.0 - i * 0.01, "classyfire": {}}
        for i in range(100)
    ]
    facts = sirius.extract({"candidates": candidates}, _ctx({}))
    assert len(facts) == 5


def test_sirius_empty_candidates_returns_empty():
    assert sirius.extract({"candidates": []}, _ctx()) == []
    assert sirius.extract({}, _ctx()) == []


def test_sirius_skips_malformed_candidates():
    result = {
        "candidates": [
            "not a dict",
            {"smiles": "CCO", "score": 0.9, "classyfire": {}},
            {"no_smiles": True, "score": 0.5},  # missing smiles
            {"smiles": "CCN", "score": "oops"},  # non-numeric score
        ]
    }
    facts = sirius.extract(result, _ctx())
    assert len(facts) == 1
    assert facts[0].subject_id_value == "CCO"


def test_sirius_confidence_high_tier():
    facts = sirius.extract(
        {"candidates": [{"smiles": "CCO", "score": 0.9, "classyfire": {}}]},
        _ctx({}),
    )
    assert facts[0].confidence == 0.65
    assert facts[0].confidence_tier == "high"


# ---------------------------------------------------------------------------
# crest
# ---------------------------------------------------------------------------


def test_crest_emits_count_and_lowest_energy():
    result = {
        "job_id": "crest-1",
        "cache_hit": False,
        "method": "CREST",
        "task": "conformers",
        "summary": "test",
        "ensemble": [
            {"ensemble_index": 0, "xyz": "...", "energy_hartree": -100.5, "boltzmann_weight": 0.7},
            {"ensemble_index": 1, "xyz": "...", "energy_hartree": -100.2, "boltzmann_weight": 0.3},
        ],
    }
    facts = crest.extract(result, _ctx())
    preds = {f.predicate for f in facts}
    assert preds == {"has_conformer_count", "has_lowest_conformer_energy_hartree"}
    by_pred = _by_predicate(facts)
    assert by_pred["has_conformer_count"].object_value["value"] == 2
    assert by_pred["has_lowest_conformer_energy_hartree"].object_value["value"] == -100.5
    assert by_pred["has_lowest_conformer_energy_hartree"].unit == "Hartree"


def test_crest_task_propagated_to_object_value():
    """tautomers / protomers should be distinguishable from conformers."""
    result = {
        "task": "tautomers",
        "ensemble": [{"energy_hartree": -100.0}],
    }
    facts = crest.extract(result, _ctx())
    assert all(f.object_value["task"] == "tautomers" for f in facts)


def test_crest_skips_non_numeric_energies():
    result = {
        "task": "conformers",
        "ensemble": [
            {"energy_hartree": float("nan")},
            {"energy_hartree": "oops"},
            {"energy_hartree": -50.0},
        ],
    }
    facts = crest.extract(result, _ctx())
    by_pred = _by_predicate(facts)
    # Count still 3 (we keep all dict entries) but lowest only over finite numerics.
    assert by_pred["has_conformer_count"].object_value["value"] == 3
    assert by_pred["has_lowest_conformer_energy_hartree"].object_value["value"] == -50.0


def test_crest_no_energy_only_count_fact():
    """If no finite energies, only the count fact is emitted."""
    result = {"task": "conformers", "ensemble": [{"ensemble_index": 0, "xyz": "..."}]}
    facts = crest.extract(result, _ctx())
    preds = {f.predicate for f in facts}
    assert preds == {"has_conformer_count"}


def test_crest_empty_ensemble_returns_empty():
    assert crest.extract({"ensemble": []}, _ctx()) == []
    assert crest.extract({}, _ctx()) == []


def test_crest_no_smiles_returns_empty():
    """Without a SMILES we can't subject-anchor the facts."""
    assert (
        crest.extract({"ensemble": [{"energy_hartree": -1.0}]}, _ctx({})) == []
    )


def test_crest_confidence_high_tier():
    facts = crest.extract(
        {"ensemble": [{"energy_hartree": -1.0}]},
        _ctx(),
    )
    assert facts[0].confidence == 0.80
    # 0.80 is high tier (>= 0.65 < 0.85).
    assert facts[0].confidence_tier == "high"


# ---------------------------------------------------------------------------
# synthegy
# ---------------------------------------------------------------------------


def test_synthegy_emits_step_count_fact():
    result = {
        "moves": [
            {"from_smiles": "A", "to_smiles": "B", "score": 8.0},
            {"from_smiles": "B", "to_smiles": "C", "score": 7.5},
        ],
        "reactants_smiles": "A",
        "products_smiles": "C",
        "truncated": False,
    }
    facts = synthegy.extract(result, _ctx())
    by_pred = _by_predicate(facts)
    assert "has_mechanism_step_count" in by_pred
    assert by_pred["has_mechanism_step_count"].object_value["value"] == 2
    assert by_pred["has_mechanism_step_count"].subject_label == "Reaction"
    assert by_pred["has_mechanism_step_count"].subject_id_value == "A>>C"


def test_synthegy_top_barrier_taken_from_max_delta():
    result = {
        "moves": [
            {"from_smiles": "A", "to_smiles": "B", "score": 8.0, "energy_delta_hartree": 0.01},
            {"from_smiles": "B", "to_smiles": "C", "score": 7.5, "energy_delta_hartree": 0.05},
            {"from_smiles": "C", "to_smiles": "D", "score": 6.0, "energy_delta_hartree": 0.02},
        ],
        "reactants_smiles": "A",
        "products_smiles": "D",
    }
    facts = synthegy.extract(result, _ctx())
    by_pred = _by_predicate(facts)
    # Max delta is 0.05 Hartree → 0.05 * 2625.5 ≈ 131.27 kJ/mol
    barrier = by_pred["has_mechanism_top_barrier_kj_mol"]
    assert barrier.object_value["value"] == pytest.approx(131.27, rel=1e-3)
    assert barrier.object_value["raw_hartree"] == 0.05
    assert barrier.unit == "kJ/mol"


def test_synthegy_no_deltas_only_step_count_fact():
    """When validate_energies wasn't requested, no energy_delta_hartree is present."""
    result = {
        "moves": [
            {"from_smiles": "A", "to_smiles": "B", "score": 8.0},
        ],
        "reactants_smiles": "A",
        "products_smiles": "B",
    }
    facts = synthegy.extract(result, _ctx())
    preds = {f.predicate for f in facts}
    assert preds == {"has_mechanism_step_count"}


def test_synthegy_empty_moves_returns_empty():
    """A truncated search returns moves=[] — no useful facts."""
    result = {"moves": [], "reactants_smiles": "A", "products_smiles": "B", "truncated": True}
    assert synthegy.extract(result, _ctx()) == []


def test_synthegy_no_rxn_smiles_returns_empty():
    """Without both reactants and products we can't form the rxn_smiles subject."""
    result = {"moves": [{"from_smiles": "A", "to_smiles": "B", "score": 1.0}]}
    assert synthegy.extract(result, _ctx({})) == []


def test_synthegy_falls_back_to_args_for_rxn_smiles():
    """If the response doesn't echo reactants/products, the args should work."""
    result = {"moves": [{"from_smiles": "A", "to_smiles": "B", "score": 1.0}]}
    facts = synthegy.extract(
        result, _ctx({"reactants_smiles": "X", "products_smiles": "Y"})
    )
    assert facts[0].subject_id_value == "X>>Y"


def test_synthegy_confidence_high_tier():
    result = {
        "moves": [{"from_smiles": "A", "to_smiles": "B", "score": 8.0}],
        "reactants_smiles": "A",
        "products_smiles": "B",
    }
    facts = synthegy.extract(result, _ctx())
    assert facts[0].confidence == 0.70
    assert facts[0].confidence_tier == "high"


def test_synthegy_truncated_flag_propagated():
    result = {
        "moves": [{"from_smiles": "A", "to_smiles": "B", "score": 8.0}],
        "reactants_smiles": "A",
        "products_smiles": "B",
        "truncated": True,
    }
    facts = synthegy.extract(result, _ctx())
    assert facts[0].object_value["truncated"] is True


# ---------------------------------------------------------------------------
# tabicl
# ---------------------------------------------------------------------------


def test_tabicl_emits_per_prediction_facts():
    rxn_a = str(uuid.uuid4())
    rxn_b = str(uuid.uuid4())
    result = {
        "task": "regression",
        "support_size": 50,
        "predictions": [
            {"query_reaction_id": rxn_a, "predicted_yield_pct": 75.0, "std": 5.0},
            {"query_reaction_id": rxn_b, "predicted_yield_pct": 60.0, "std": 10.0},
        ],
        "caveats": [],
    }
    facts = tabicl.extract(result, _ctx())
    assert len(facts) == 2
    assert all(f.predicate == "has_tabicl_predicted_yield_pct" for f in facts)
    assert all(f.subject_label == "Reaction" for f in facts)
    assert {f.subject_id_value for f in facts} == {rxn_a, rxn_b}


def test_tabicl_subject_id_is_reaction_uuid_not_smiles():
    rxn_id = str(uuid.uuid4())
    result = {
        "predictions": [
            {"query_reaction_id": rxn_id, "predicted_yield_pct": 50.0, "std": 5.0},
        ]
    }
    facts = tabicl.extract(result, _ctx())
    assert facts[0].subject_id_value == rxn_id


def test_tabicl_high_std_drops_to_high_tier():
    result = {
        "predictions": [
            {"query_reaction_id": str(uuid.uuid4()), "predicted_yield_pct": 50.0, "std": 18.0},
            # rel = 0.36 → 0.65 confidence
        ]
    }
    facts = tabicl.extract(result, _ctx())
    assert facts[0].confidence == 0.65
    assert facts[0].confidence_tier == "high"


def test_tabicl_caveats_propagated_to_object_value():
    result = {
        "support_size": 5,
        "predictions": [
            {"query_reaction_id": str(uuid.uuid4()), "predicted_yield_pct": 50.0, "std": 1.0},
        ],
        "caveats": ["small support set"],
    }
    facts = tabicl.extract(result, _ctx())
    assert facts[0].object_value["caveats"] == ["small support set"]
    assert facts[0].object_value["support_size"] == 5


def test_tabicl_empty_predictions_returns_empty():
    assert tabicl.extract({"predictions": []}, _ctx()) == []
    assert tabicl.extract({}, _ctx()) == []


def test_tabicl_skips_predictions_missing_fields():
    result = {
        "predictions": [
            {"query_reaction_id": str(uuid.uuid4()), "predicted_yield_pct": 50.0, "std": 1.0},
            {"predicted_yield_pct": 60.0},  # missing query_reaction_id
            {"query_reaction_id": str(uuid.uuid4())},  # missing yield
            "not a dict",
        ]
    }
    facts = tabicl.extract(result, _ctx())
    assert len(facts) == 1


def test_tabicl_feature_importance_only_returns_empty():
    """rank_feature_importance responses carry no `predictions` — extractor skips."""
    result = {
        "task": "regression",
        "support_size": 50,
        "feature_importance": [{"feature": "drfp_0", "importance": 0.5}],
        "caveats": [],
    }
    assert tabicl.extract(result, _ctx()) == []


# ---------------------------------------------------------------------------
# genchem
# ---------------------------------------------------------------------------


def test_genchem_emits_single_rollup_fact():
    """Critical: ONE fact per run, NOT per candidate."""
    result = {
        "run_id": "gen-001",
        "kind": "scaffold",
        "n_proposed": 250,
        "proposals": [{"smiles": f"C{'C' * i}", "inchikey": None} for i in range(250)],
    }
    facts = genchem.extract(
        result, _ctx({"project_internal_id": "proj-1", "seed_smiles": "c1ccccc1[*:1]"})
    )
    assert len(facts) == 1
    f = facts[0]
    assert f.subject_label == "Project"
    assert f.subject_id_value == "proj-1"
    assert f.predicate == "has_generated_library"
    assert f.object_value["value"] == "gen-001"
    assert f.object_value["candidate_count"] == 250


def test_genchem_falls_back_to_ctx_project():
    ctx = _ctx({"seed_smiles": "CCO"})
    ctx_project = ctx.project_id
    assert ctx_project is not None
    result = {"run_id": "gen-002", "kind": "grow", "n_proposed": 10, "proposals": []}
    facts = genchem.extract(result, ctx)
    assert facts[0].subject_id_value == ctx_project


def test_genchem_no_run_id_returns_empty():
    """Without a stable run_id we have no useful subject anchor."""
    result = {"run_id": None, "kind": "scaffold", "n_proposed": 5}
    assert genchem.extract(result, _ctx({"project_internal_id": "proj-1"})) == []
    result["run_id"] = ""
    assert genchem.extract(result, _ctx({"project_internal_id": "proj-1"})) == []


def test_genchem_no_project_returns_empty():
    ctx = ExtractionContext(
        tool_name="t",
        user_entra_id="u",
        project_id=None,
        args={"seed_smiles": "CCO"},
        invocation_id="i",
        duration_ms=0,
    )
    result = {"run_id": "gen-003", "kind": "scaffold", "n_proposed": 1}
    assert genchem.extract(result, ctx) == []


def test_genchem_falls_back_candidate_count_to_proposals_length():
    """If n_proposed is missing, derive count from len(proposals)."""
    result = {
        "run_id": "gen-004",
        "kind": "bioisostere",
        "proposals": [{"smiles": "CCO"}, {"smiles": "CCN"}, {"smiles": "CCC"}],
    }
    facts = genchem.extract(
        result, _ctx({"project_internal_id": "proj-1"})
    )
    assert facts[0].object_value["candidate_count"] == 3


def test_genchem_confidence_medium_tier():
    """0.50 → medium tier per common.confidence_tier."""
    result = {"run_id": "gen-005", "kind": "scaffold", "n_proposed": 1, "proposals": []}
    facts = genchem.extract(
        result, _ctx({"project_internal_id": "proj-1"})
    )
    assert facts[0].confidence == 0.50
    # 0.50 → "medium" per confidence_tier (>= 0.40 < 0.65 → medium).
    assert facts[0].confidence_tier == "medium"


def test_genchem_seed_smiles_resolved_from_args():
    """The genchem builtin uses different arg names depending on kind."""
    result = {"run_id": "g", "kind": "scaffold", "n_proposed": 1}
    # scaffold_smiles
    facts = genchem.extract(
        result,
        _ctx({"project_internal_id": "p", "scaffold_smiles": "c1ccccc1[*:1]"}),
    )
    assert facts[0].object_value["seed_smiles"] == "c1ccccc1[*:1]"
    # query_smiles (bioisostere path)
    facts = genchem.extract(
        result, _ctx({"project_internal_id": "p", "query_smiles": "CCN"})
    )
    assert facts[0].object_value["seed_smiles"] == "CCN"
    # fragment_smiles (grow path)
    facts = genchem.extract(
        result, _ctx({"project_internal_id": "p", "fragment_smiles": "CCO"})
    )
    assert facts[0].object_value["seed_smiles"] == "CCO"


# ---------------------------------------------------------------------------
# Defensive — every extractor swallows arbitrary garbage
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "extractor",
    [
        sirius.extract,
        crest.extract,
        synthegy.extract,
        tabicl.extract,
        genchem.extract,
    ],
)
def test_extractor_swallows_garbage_result(extractor):
    """Top-level extract() must return [] on any kind of garbage rather than raise."""
    assert extractor({}, _ctx()) == []
    assert extractor({"unrelated": "noise"}, _ctx()) == []
    # Also exercise pathologically wrong types in the expected fields.
    assert extractor({"candidates": "nope"}, _ctx()) == []
    assert extractor({"ensemble": 123}, _ctx()) == []
    assert extractor({"moves": "not a list"}, _ctx()) == []
    assert extractor({"predictions": {"not": "a list"}}, _ctx()) == []
    assert extractor({"run_id": 12345}, _ctx()) == []
