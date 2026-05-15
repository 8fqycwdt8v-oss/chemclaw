"""Unit tests for the xtb single_point extractor (Phase 1.1 pilot).

Pure-function tests — no DB, no network, no RDKit. The extractor's
contract is: typed Pydantic-style dict in, list[FactDraft] out, never
raise.
"""
from __future__ import annotations

import uuid
from typing import Any

import pytest

from services.projectors.fact_extractor.xtb import extract
from services.projectors.tool_result_extractor.main import (
    ExtractionContext,
    FactDraft,
)


def _ctx(args: dict[str, Any] | None = None) -> ExtractionContext:
    # `args is None` → use the default; an explicit `{}` is honored so
    # tests can simulate the "no SMILES" case.
    resolved_args = (
        {"smiles": "CCO", "method": "GFN2"} if args is None else args
    )
    return ExtractionContext(
        tool_name="qm_single_point",
        user_entra_id="test-user",
        project_id=str(uuid.uuid4()),
        args=resolved_args,
        invocation_id=str(uuid.uuid4()),
        duration_ms=1234,
    )


def _by_predicate(facts: list[FactDraft]) -> dict[str, FactDraft]:
    return {f.predicate: f for f in facts}


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_extract_full_single_point_response():
    """All three fields present → three facts."""
    result = {
        "job_id": "xtb-001",
        "cache_hit": False,
        "status": "succeeded",
        "method": "GFN2",
        "energy_hartree": -154.39,
        "homo_lumo_eV": 4.2,
        "dipole": [0.5, 0.0, 0.3],
    }
    facts = extract(result, _ctx())
    assert len(facts) == 3
    by_pred = _by_predicate(facts)
    assert "has_xtb_single_point_energy_hartree" in by_pred
    assert "has_homo_lumo_gap_eV" in by_pred
    assert "has_xtb_dipole_debye" in by_pred


def test_extract_energy_value_correct():
    facts = extract(
        {"energy_hartree": -154.39, "method": "GFN2"},
        _ctx(),
    )
    assert len(facts) == 1
    assert facts[0].predicate == "has_xtb_single_point_energy_hartree"
    assert facts[0].object_value["value"] == -154.39
    assert facts[0].unit == "Hartree"
    assert facts[0].derivation_class == "COMPUTED"


def test_extract_homo_lumo_gap_only():
    facts = extract({"homo_lumo_eV": 5.6, "method": "GFN2"}, _ctx())
    assert len(facts) == 1
    assert facts[0].predicate == "has_homo_lumo_gap_eV"
    assert facts[0].object_value["value"] == 5.6
    assert facts[0].unit == "eV"


def test_extract_dipole_magnitude():
    facts = extract(
        {"dipole": [3.0, 4.0, 0.0], "method": "GFN2"},
        _ctx(),
    )
    assert len(facts) == 1
    assert facts[0].predicate == "has_xtb_dipole_debye"
    # |dipole|_au = 5.0; conv to Debye: 5.0 * 2.541746229 ≈ 12.709
    assert facts[0].object_value["value"] == pytest.approx(12.7087, rel=1e-3)
    assert facts[0].unit == "D"


# ---------------------------------------------------------------------------
# Confidence + tier
# ---------------------------------------------------------------------------


def test_gfn2_confidence_high_tier():
    facts = extract(
        {"energy_hartree": -1.0, "method": "GFN2"},
        _ctx(),
    )
    assert facts[0].confidence == 0.85
    assert facts[0].confidence_tier == "foundational"


def test_gff_confidence_medium_tier():
    """GFN-FF (force field) degrades confidence."""
    facts = extract(
        {"energy_hartree": -1.0, "method": "GFN-FF"},
        _ctx({"smiles": "CCO", "method": "GFN-FF"}),
    )
    assert facts[0].confidence == 0.70
    assert facts[0].confidence_tier == "high"


# ---------------------------------------------------------------------------
# Subject ID resolution
# ---------------------------------------------------------------------------


def test_subject_from_canonical_smiles_in_response():
    """Cached responses include `smiles_canonical`; prefer that over args."""
    facts = extract(
        {"energy_hartree": -1.0, "smiles_canonical": "CCO_canonical"},
        _ctx({"smiles": "raw"}),
    )
    assert facts[0].subject_id_value == "CCO_canonical"


def test_subject_falls_back_to_args_smiles():
    facts = extract(
        {"energy_hartree": -1.0},
        _ctx({"smiles": "CCO"}),
    )
    assert facts[0].subject_id_value == "CCO"


def test_no_smiles_returns_empty():
    """Without a SMILES we can't subject-anchor the fact."""
    facts = extract({"energy_hartree": -1.0}, _ctx({}))
    assert facts == []


# ---------------------------------------------------------------------------
# Edge cases — extractor must never raise
# ---------------------------------------------------------------------------


def test_empty_result_returns_empty():
    assert extract({}, _ctx()) == []


def test_unrelated_response_returns_empty():
    """An xtb response from a different task (e.g. just `optimized_xyz`)
    has no single_point fields — extractor should no-op."""
    assert extract({"optimized_xyz": "..."}, _ctx()) == []


def test_malformed_dipole_does_not_raise():
    """A short / wrong-shape dipole vector should produce no dipole fact
    but not crash the projector."""
    facts = extract(
        {"energy_hartree": -1.0, "dipole": [1.0, 2.0]},  # only 2 dims
        _ctx(),
    )
    by_pred = _by_predicate(facts)
    assert "has_xtb_dipole_debye" not in by_pred
    assert "has_xtb_single_point_energy_hartree" in by_pred


def test_non_numeric_energy_skipped():
    """If a backend bug surfaces a string energy, skip silently rather
    than crash."""
    facts = extract({"energy_hartree": "oops"}, _ctx())
    assert facts == []


def test_extractor_swallows_unexpected_exceptions(monkeypatch):
    """Even pathological input must not propagate."""
    # Force an internal helper to raise; the top-level extract() must
    # still return [] rather than propagate.
    from services.projectors.fact_extractor import xtb as mod

    def boom(*_a, **_kw):
        raise RuntimeError("pathological")

    monkeypatch.setattr(mod, "_extract_single_point", boom)
    facts = extract({"energy_hartree": -1.0}, _ctx())
    assert facts == []


# ---------------------------------------------------------------------------
# Common object_value content
# ---------------------------------------------------------------------------


def test_method_in_object_value():
    facts = extract(
        {"energy_hartree": -1.0, "method": "GFN2"},
        _ctx(),
    )
    assert facts[0].object_value["method"] == "GFN2"


def test_cache_hit_propagated():
    facts = extract(
        {"energy_hartree": -1.0, "cache_hit": True},
        _ctx(),
    )
    assert facts[0].object_value["cache_hit"] is True


def test_job_id_propagated():
    facts = extract(
        {"energy_hartree": -1.0, "job_id": "xtb-job-42"},
        _ctx(),
    )
    assert facts[0].object_value["job_id"] == "xtb-job-42"
