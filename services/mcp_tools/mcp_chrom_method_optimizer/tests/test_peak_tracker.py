"""Tests for cross-run peak tracking (Phase 2). Pure functions."""
from __future__ import annotations

from services.mcp_tools.mcp_chrom_method_optimizer import peak_tracker as _pt


def test_match_by_name_case_insensitive():
    peaks = [
        {"rt_min": 2.1, "name": "  Impurity A "},
        {"rt_min": 3.4, "name": "API"},
    ]
    targets = [{"name": "api"}, {"name": "impurity a"}]
    m = _pt.match_targets(peaks, targets)
    assert set(m["matched"].keys()) == {"api", "impurity a"}
    assert m["matched"]["api"]["rt_min"] == 3.4
    assert m["confidence"] == "high"
    assert m["unmatched_targets"] == []


def test_match_by_mz_within_tolerance():
    peaks = [
        {"rt_min": 2.0, "m_z": 250.3},
        {"rt_min": 4.0, "m_z": 401.1},
    ]
    targets = [{"name": "X", "m_z": 250.5}, {"name": "Y", "m_z": 401.0}]
    m = _pt.match_targets(peaks, targets, mz_tolerance=0.5)
    assert m["matched"]["X"]["rt_min"] == 2.0
    assert m["matched"]["Y"]["rt_min"] == 4.0
    assert m["confidence"] == "high"


def test_unmatched_target_marks_partial_confidence():
    peaks = [{"rt_min": 2.0, "name": "found"}]
    targets = [{"name": "found"}, {"name": "missing", "m_z": 999.0}]
    m = _pt.match_targets(peaks, targets)
    assert m["unmatched_targets"] == ["missing"]
    assert m["confidence"] == "partial"
    assert "found" in m["matched"]


def test_extra_peaks_reported():
    peaks = [
        {"rt_min": 2.0, "name": "target"},
        {"rt_min": 3.0, "name": "unknown impurity"},
    ]
    m = _pt.match_targets(peaks, [{"name": "target"}])
    assert len(m["extra_peaks"]) == 1
    assert m["extra_peaks"][0]["name"] == "unknown impurity"


def test_critical_pair_peaks_unknown_impurity_mode():
    peaks = [{"rt_min": 1.0}, {"rt_min": 2.0}, {"rt_min": 3.0}]
    used, conf = _pt.critical_pair_peaks(peaks, None)
    assert used == peaks
    assert conf == "high"


def test_critical_pair_peaks_target_mode_restricts_to_matched():
    peaks = [
        {"rt_min": 1.0, "name": "filler"},
        {"rt_min": 2.0, "name": "A"},
        {"rt_min": 3.0, "name": "B"},
    ]
    used, conf = _pt.critical_pair_peaks(peaks, [{"name": "A"}, {"name": "B"}])
    assert {p["name"] for p in used} == {"A", "B"}
    assert conf == "high"


def test_each_peak_matched_at_most_once():
    # Two targets, only one matching peak by name; the second can't steal it.
    peaks = [{"rt_min": 2.0, "name": "shared", "m_z": 100.0}]
    targets = [{"name": "shared"}, {"name": "other", "m_z": 100.0}]
    m = _pt.match_targets(peaks, targets, mz_tolerance=0.5)
    assert "shared" in m["matched"]
    assert "other" in m["unmatched_targets"]
