"""Unit tests for Phase 2 ELN/LOGS extractors.

Covers: eln_reaction, eln_experiment, eln_sample, eln_entry, hplc, nmr, ms.
Same contract: pure functions, no DB/network, must never raise on any input.
"""
from __future__ import annotations

import uuid
from typing import Any

import pytest

from services.projectors.fact_extractor import (
    eln_entry,
    eln_experiment,
    eln_reaction,
    eln_sample,
    hplc,
    ms,
    nmr,
)
from services.projectors.tool_result_extractor.main import (
    ExtractionContext,
    FactDraft,
)


def _ctx(args: dict[str, Any] | None = None) -> ExtractionContext:
    resolved_args = {"smiles": "CCO", "project_code": "NCE-001"} if args is None else args
    return ExtractionContext(
        tool_name="test_tool",
        user_entra_id="test-user",
        project_id=str(uuid.uuid4()),
        args=resolved_args,
        invocation_id=str(uuid.uuid4()),
        duration_ms=100,
    )


def _preds(facts: list[FactDraft]) -> set[str]:
    return {f.predicate for f in facts}


def _by_pred(facts: list[FactDraft]) -> dict[str, FactDraft]:
    return {f.predicate: f for f in facts}


# ---------------------------------------------------------------------------
# eln_reaction
# ---------------------------------------------------------------------------


def test_eln_reaction_happy_path():
    result = {
        "items": [
            {
                "smiles": "CCO",
                "yield_pct": 85.0,
                "conditions": {"temperature_c": 120.0},
                "ofat_count": 12,
            }
        ]
    }
    facts = eln_reaction.extract(result, _ctx())
    preds = _preds(facts)
    assert "has_eln_yield_pct" in preds
    assert "has_eln_temperature_c" in preds
    assert "has_eln_ofat_count" in preds


def test_eln_reaction_yield_value():
    result = {"items": [{"smiles": "CCO", "yield_pct": 72.5}]}
    facts = eln_reaction.extract(result, _ctx())
    by_pred = _by_pred(facts)
    assert by_pred["has_eln_yield_pct"].object_value["value"] == pytest.approx(72.5)


def test_eln_reaction_temperature_from_conditions():
    result = {
        "items": [{"smiles": "CCO", "conditions": {"temperature_c": 80}}]
    }
    facts = eln_reaction.extract(result, _ctx())
    by_pred = _by_pred(facts)
    assert by_pred["has_eln_temperature_c"].object_value["value"] == pytest.approx(80.0)


def test_eln_reaction_ofat_count_integer():
    result = {"items": [{"smiles": "CCO", "ofat_count": 7}]}
    facts = eln_reaction.extract(result, _ctx())
    by_pred = _by_pred(facts)
    assert by_pred["has_eln_ofat_count"].object_value["value"] == 7


def test_eln_reaction_caps_at_five():
    items = [{"smiles": f"C{i}", "yield_pct": 50.0} for i in range(10)]
    facts = eln_reaction.extract({"items": items}, _ctx())
    smiles_seen = {f.subject_id_value for f in facts}
    assert len(smiles_seen) <= 5


def test_eln_reaction_skips_missing_smiles():
    result = {"items": [{"yield_pct": 70.0}]}
    facts = eln_reaction.extract(result, _ctx())
    assert facts == []


def test_eln_reaction_empty_items():
    assert eln_reaction.extract({"items": []}, _ctx()) == []


def test_eln_reaction_no_items_key():
    assert eln_reaction.extract({}, _ctx()) == []


def test_eln_reaction_confidence():
    result = {"items": [{"smiles": "CCO", "yield_pct": 50.0}]}
    facts = eln_reaction.extract(result, _ctx())
    assert all(f.confidence == pytest.approx(0.92) for f in facts)


def test_eln_reaction_unit_on_yield():
    result = {"items": [{"smiles": "CCO", "yield_pct": 50.0}]}
    facts = eln_reaction.extract(result, _ctx())
    by_pred = _by_pred(facts)
    assert by_pred["has_eln_yield_pct"].unit == "%"


def test_eln_reaction_conditions_not_dict():
    result = {"items": [{"smiles": "CCO", "conditions": "hot"}]}
    facts = eln_reaction.extract(result, _ctx())
    preds = _preds(facts)
    assert "has_eln_temperature_c" not in preds


# ---------------------------------------------------------------------------
# eln_experiment
# ---------------------------------------------------------------------------


def test_eln_experiment_happy_path():
    result = {
        "experiments": [
            {
                "experiment_id": "exp-1",
                "project_code": "NCE-001",
                "experiment_type": "OFAT",
                "status": "completed",
                "entry_count": 42,
            }
        ]
    }
    facts = eln_experiment.extract(result, _ctx())
    preds = _preds(facts)
    assert "has_eln_experiment_type" in preds
    assert "has_eln_experiment_status" in preds
    assert "has_eln_entry_count" in preds


def test_eln_experiment_project_code_from_ctx():
    result = {
        "experiments": [
            {"experiment_id": "e1", "experiment_type": "HTE", "entry_count": 5}
        ]
    }
    facts = eln_experiment.extract(result, _ctx({"project_code": "NCE-XYZ"}))
    assert all(f.subject_id_value == "NCE-XYZ" for f in facts)


def test_eln_experiment_project_code_fallback_unknown():
    result = {
        "experiments": [{"experiment_id": "e1", "experiment_type": "HTE", "entry_count": 1}]
    }
    facts = eln_experiment.extract(result, _ctx({}))
    assert all(f.subject_id_value == "unknown" for f in facts)


def test_eln_experiment_caps_at_three():
    exps = [
        {"project_code": "P1", "experiment_type": "T", "status": "done", "entry_count": i}
        for i in range(6)
    ]
    facts = eln_experiment.extract({"experiments": exps}, _ctx())
    entry_counts = [f for f in facts if f.predicate == "has_eln_entry_count"]
    assert len(entry_counts) <= 3


def test_eln_experiment_empty_experiments():
    assert eln_experiment.extract({"experiments": []}, _ctx()) == []


def test_eln_experiment_no_key():
    assert eln_experiment.extract({}, _ctx()) == []


def test_eln_experiment_skips_non_string_type():
    result = {"experiments": [{"project_code": "P1", "experiment_type": 42}]}
    facts = eln_experiment.extract(result, _ctx())
    preds = _preds(facts)
    assert "has_eln_experiment_type" not in preds


def test_eln_experiment_confidence():
    result = {
        "experiments": [{"project_code": "P1", "experiment_type": "HTE", "entry_count": 3}]
    }
    facts = eln_experiment.extract(result, _ctx())
    assert all(f.confidence == pytest.approx(0.90) for f in facts)


# ---------------------------------------------------------------------------
# eln_sample
# ---------------------------------------------------------------------------


def test_eln_sample_happy_path():
    result = {
        "samples": [
            {"inchikey": "AAAA-BBBB-CCCC", "purity_pct": 98.5, "sample_id": "s1"}
        ]
    }
    facts = eln_sample.extract(result, _ctx())
    assert len(facts) == 1
    assert facts[0].predicate == "has_eln_purity_pct"
    assert facts[0].object_value["value"] == pytest.approx(98.5)


def test_eln_sample_inchikey_preferred_over_smiles():
    result = {
        "samples": [{"inchikey": "IK123", "smiles": "CCO", "purity_pct": 90.0}]
    }
    facts = eln_sample.extract(result, _ctx())
    assert facts[0].subject_id_value == "IK123"


def test_eln_sample_falls_back_to_smiles():
    result = {"samples": [{"smiles": "CCO", "purity_pct": 90.0}]}
    facts = eln_sample.extract(result, _ctx())
    assert facts[0].subject_id_value == "CCO"


def test_eln_sample_rejects_purity_above_100():
    result = {"samples": [{"inchikey": "IK1", "purity_pct": 101.0}]}
    assert eln_sample.extract(result, _ctx()) == []


def test_eln_sample_rejects_purity_below_0():
    result = {"samples": [{"inchikey": "IK1", "purity_pct": -1.0}]}
    assert eln_sample.extract(result, _ctx()) == []


def test_eln_sample_caps_at_five():
    samples = [{"inchikey": f"IK{i}", "purity_pct": 90.0} for i in range(10)]
    facts = eln_sample.extract({"samples": samples}, _ctx())
    assert len(facts) <= 5


def test_eln_sample_skips_missing_compound_id():
    result = {"samples": [{"purity_pct": 90.0}]}
    assert eln_sample.extract(result, _ctx()) == []


def test_eln_sample_empty_samples():
    assert eln_sample.extract({"samples": []}, _ctx()) == []


def test_eln_sample_unit_is_percent():
    result = {"samples": [{"inchikey": "IK1", "purity_pct": 80.0}]}
    facts = eln_sample.extract(result, _ctx())
    assert facts[0].unit == "%"


def test_eln_sample_confidence():
    result = {"samples": [{"inchikey": "IK1", "purity_pct": 80.0}]}
    facts = eln_sample.extract(result, _ctx())
    assert facts[0].confidence == pytest.approx(0.92)


# ---------------------------------------------------------------------------
# eln_entry
# ---------------------------------------------------------------------------


def test_eln_entry_happy_path():
    result = {
        "entries": [
            {"compound_smiles": "CCO", "notes": "Reaction went well.", "entry_id": "e1"}
        ]
    }
    facts = eln_entry.extract(result, _ctx())
    assert len(facts) == 1
    assert facts[0].predicate == "has_eln_free_text_note"
    assert facts[0].object_value["value"] is True


def test_eln_entry_smiles_from_ctx_fallback():
    result = {"entries": [{"notes": "Something happened", "entry_id": "e1"}]}
    facts = eln_entry.extract(result, _ctx({"smiles": "c1ccccc1"}))
    assert facts[0].subject_id_value == "c1ccccc1"


def test_eln_entry_skips_empty_notes():
    result = {"entries": [{"compound_smiles": "CCO", "notes": "   "}]}
    assert eln_entry.extract(result, _ctx()) == []


def test_eln_entry_skips_non_string_notes():
    result = {"entries": [{"compound_smiles": "CCO", "notes": None}]}
    assert eln_entry.extract(result, _ctx()) == []


def test_eln_entry_does_not_expose_note_body():
    result = {"entries": [{"compound_smiles": "CCO", "notes": "SECRET_DATA"}]}
    facts = eln_entry.extract(result, _ctx())
    assert len(facts) == 1
    for v in str(facts[0].object_value).split():
        assert "SECRET_DATA" not in v


def test_eln_entry_skips_no_compound_id():
    result = {"entries": [{"notes": "Some note"}]}
    assert eln_entry.extract(result, _ctx({})) == []


def test_eln_entry_caps_at_five():
    entries = [
        {"compound_smiles": f"C{i}", "notes": "note", "entry_id": f"e{i}"}
        for i in range(10)
    ]
    facts = eln_entry.extract({"entries": entries}, _ctx())
    assert len(facts) <= 5


def test_eln_entry_confidence():
    result = {"entries": [{"compound_smiles": "CCO", "notes": "test"}]}
    facts = eln_entry.extract(result, _ctx())
    assert facts[0].confidence == pytest.approx(0.60)


# ---------------------------------------------------------------------------
# hplc
# ---------------------------------------------------------------------------


def test_hplc_happy_path():
    result = {
        "datasets": [
            {
                "compound_smiles": "CCO",
                "dataset_id": "d1",
                "purity_pct": 98.1,
                "peak_count": 3,
                "main_peak_rt_min": 4.2,
            }
        ]
    }
    facts = hplc.extract(result, _ctx())
    preds = _preds(facts)
    assert "has_hplc_purity_pct" in preds
    assert "has_hplc_peak_count" in preds
    assert "has_hplc_main_peak_rt_min" in preds


def test_hplc_purity_value():
    result = {"datasets": [{"compound_smiles": "CCO", "purity_pct": 95.5}]}
    facts = hplc.extract(result, _ctx())
    by_pred = _by_pred(facts)
    assert by_pred["has_hplc_purity_pct"].object_value["value"] == pytest.approx(95.5)


def test_hplc_smiles_from_ctx_fallback():
    result = {"datasets": [{"purity_pct": 90.0}]}
    facts = hplc.extract(result, _ctx({"smiles": "c1ccccc1"}))
    assert facts[0].subject_id_value == "c1ccccc1"


def test_hplc_caps_at_three():
    datasets = [{"compound_smiles": f"C{i}", "purity_pct": 90.0} for i in range(6)]
    facts = hplc.extract({"datasets": datasets}, _ctx())
    smiles_seen = {f.subject_id_value for f in facts}
    assert len(smiles_seen) <= 3


def test_hplc_skips_no_smiles():
    result = {"datasets": [{"purity_pct": 90.0}]}
    assert hplc.extract(result, _ctx({})) == []


def test_hplc_peak_count_int_only():
    result = {"datasets": [{"compound_smiles": "CCO", "peak_count": 3.7}]}
    facts = hplc.extract(result, _ctx())
    preds = _preds(facts)
    assert "has_hplc_peak_count" not in preds


def test_hplc_unit_on_purity():
    result = {"datasets": [{"compound_smiles": "CCO", "purity_pct": 90.0}]}
    facts = hplc.extract(result, _ctx())
    by_pred = _by_pred(facts)
    assert by_pred["has_hplc_purity_pct"].unit == "%"


def test_hplc_unit_on_rt():
    result = {"datasets": [{"compound_smiles": "CCO", "main_peak_rt_min": 5.0}]}
    facts = hplc.extract(result, _ctx())
    by_pred = _by_pred(facts)
    assert by_pred["has_hplc_main_peak_rt_min"].unit == "min"


def test_hplc_confidence():
    result = {"datasets": [{"compound_smiles": "CCO", "purity_pct": 90.0}]}
    facts = hplc.extract(result, _ctx())
    assert all(f.confidence == pytest.approx(0.90) for f in facts)


# ---------------------------------------------------------------------------
# nmr
# ---------------------------------------------------------------------------


def test_nmr_shift_count_from_field():
    result = {
        "datasets": [{"compound_smiles": "CCO", "dataset_id": "n1", "shift_count": 5}]
    }
    facts = nmr.extract(result, _ctx())
    assert len(facts) == 1
    assert facts[0].predicate == "has_nmr_shift_count"
    assert facts[0].object_value["value"] == 5


def test_nmr_shift_count_from_shifts_ppm_list():
    result = {
        "datasets": [
            {"compound_smiles": "CCO", "shifts_ppm": [1.2, 3.4, 7.8, 128.0]}
        ]
    }
    facts = nmr.extract(result, _ctx())
    assert facts[0].object_value["value"] == 4


def test_nmr_prefers_shift_count_over_shifts_ppm():
    result = {
        "datasets": [
            {"compound_smiles": "CCO", "shift_count": 10, "shifts_ppm": [1.0, 2.0]}
        ]
    }
    facts = nmr.extract(result, _ctx())
    assert facts[0].object_value["value"] == 10


def test_nmr_caps_at_three():
    datasets = [
        {"compound_smiles": f"C{i}", "shift_count": i + 1} for i in range(6)
    ]
    facts = nmr.extract({"datasets": datasets}, _ctx())
    smiles_seen = {f.subject_id_value for f in facts}
    assert len(smiles_seen) <= 3


def test_nmr_skips_no_smiles():
    result = {"datasets": [{"shift_count": 5}]}
    assert nmr.extract(result, _ctx({})) == []


def test_nmr_smiles_from_ctx_fallback():
    result = {"datasets": [{"shift_count": 3}]}
    facts = nmr.extract(result, _ctx({"smiles": "c1ccccc1"}))
    assert facts[0].subject_id_value == "c1ccccc1"


def test_nmr_allows_zero_shifts():
    result = {"datasets": [{"compound_smiles": "CCO", "shift_count": 0}]}
    facts = nmr.extract(result, _ctx())
    assert facts[0].object_value["value"] == 0


def test_nmr_empty_datasets():
    assert nmr.extract({"datasets": []}, _ctx()) == []


def test_nmr_confidence():
    result = {"datasets": [{"compound_smiles": "CCO", "shift_count": 5}]}
    facts = nmr.extract(result, _ctx())
    assert facts[0].confidence == pytest.approx(0.92)


# ---------------------------------------------------------------------------
# ms
# ---------------------------------------------------------------------------


def test_ms_happy_path():
    result = {
        "datasets": [
            {"compound_smiles": "CCO", "dataset_id": "m1", "precursor_mz": 247.1, "peak_count": 8}
        ]
    }
    facts = ms.extract(result, _ctx())
    preds = _preds(facts)
    assert "has_ms_precursor_mz" in preds
    assert "has_ms_peak_count" in preds


def test_ms_precursor_mz_value():
    result = {"datasets": [{"compound_smiles": "CCO", "precursor_mz": 312.5}]}
    facts = ms.extract(result, _ctx())
    by_pred = _by_pred(facts)
    assert by_pred["has_ms_precursor_mz"].object_value["value"] == pytest.approx(312.5)


def test_ms_rejects_zero_precursor_mz():
    result = {"datasets": [{"compound_smiles": "CCO", "precursor_mz": 0}]}
    facts = ms.extract(result, _ctx())
    preds = _preds(facts)
    assert "has_ms_precursor_mz" not in preds


def test_ms_rejects_negative_precursor_mz():
    result = {"datasets": [{"compound_smiles": "CCO", "precursor_mz": -5.0}]}
    facts = ms.extract(result, _ctx())
    preds = _preds(facts)
    assert "has_ms_precursor_mz" not in preds


def test_ms_peak_count_zero_allowed():
    result = {"datasets": [{"compound_smiles": "CCO", "peak_count": 0}]}
    facts = ms.extract(result, _ctx())
    by_pred = _by_pred(facts)
    assert by_pred["has_ms_peak_count"].object_value["value"] == 0


def test_ms_smiles_from_ctx_fallback():
    result = {"datasets": [{"precursor_mz": 200.0}]}
    facts = ms.extract(result, _ctx({"smiles": "c1ccccc1"}))
    assert facts[0].subject_id_value == "c1ccccc1"


def test_ms_caps_at_three():
    datasets = [{"compound_smiles": f"C{i}", "precursor_mz": 100.0 + i} for i in range(6)]
    facts = ms.extract({"datasets": datasets}, _ctx())
    smiles_seen = {f.subject_id_value for f in facts}
    assert len(smiles_seen) <= 3


def test_ms_skips_no_smiles():
    result = {"datasets": [{"precursor_mz": 200.0}]}
    assert ms.extract(result, _ctx({})) == []


def test_ms_unit_on_mz():
    result = {"datasets": [{"compound_smiles": "CCO", "precursor_mz": 200.0}]}
    facts = ms.extract(result, _ctx())
    by_pred = _by_pred(facts)
    assert by_pred["has_ms_precursor_mz"].unit == "m/z"


def test_ms_confidence():
    result = {"datasets": [{"compound_smiles": "CCO", "precursor_mz": 200.0}]}
    facts = ms.extract(result, _ctx())
    assert all(f.confidence == pytest.approx(0.90) for f in facts)


# ---------------------------------------------------------------------------
# Garbage-swallowing — none must raise on malformed input
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "extractor_mod",
    [eln_reaction, eln_experiment, eln_sample, eln_entry, hplc, nmr, ms],
)
@pytest.mark.parametrize(
    "bad_input",
    [
        None,
        {},
        [],
        "string",
        42,
        {"datasets": None},
        {"items": "not-a-list"},
        {"experiments": [None, "x", 42]},
        {"samples": [{"inchikey": None}]},
        {"entries": [{"compound_smiles": "", "notes": "ok"}]},
    ],
)
def test_garbage_swallowed(extractor_mod: Any, bad_input: Any) -> None:
    ctx = _ctx()
    result = bad_input if isinstance(bad_input, dict) else bad_input
    try:
        facts = extractor_mod.extract(result, ctx)
        assert isinstance(facts, list)
    except Exception as exc:  # noqa: BLE001
        pytest.fail(f"{extractor_mod.__name__}.extract raised: {exc!r}")
