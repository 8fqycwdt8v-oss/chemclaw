"""Tier 2 (bounded regex) extraction tests."""
from __future__ import annotations

import time


def test_tier2_extracts_temperature():
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    out = extract_tier2("Refluxed in DCM at 80 °C for 16 h.")
    assert out["temperature_c"] == 80.0
    assert out["_status"]["temperature_c"]["source"] == "regex"


def test_tier2_extracts_time_in_hours():
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    out = extract_tier2("Refluxed in DCM at 80 °C for 16 h.")
    assert out["time_min"] == 960.0  # 16 * 60


def test_tier2_extracts_time_in_minutes():
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    out = extract_tier2("Stirred at rt for 30 minutes.")
    assert out["time_min"] == 30.0


def test_tier2_extracts_atmosphere():
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    cases = [
        ("Reaction performed under argon.", "Ar"),
        ("under N2 atmosphere", "N2"),
        ("in air", "air"),
    ]
    for text, expected in cases:
        out = extract_tier2(text)
        assert out["atmosphere"] == expected, f"{text!r} → {out.get('atmosphere')!r}"


def test_tier2_extracts_solvent_from_known_list():
    """Solvent matched against the in-memory list of known names."""
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    out = extract_tier2("Compound dissolved in acetonitrile and stirred.")
    assert out["solvent"] == "Acetonitrile"
    assert out["_status"]["solvent"]["source"] == "regex"


def test_tier2_returns_absent_for_missing_fields():
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    out = extract_tier2("Something happened.")
    assert out["temperature_c"] is None
    assert out["_status"]["temperature_c"]["status"] == "absent"


def test_tier2_handles_empty_input():
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    out = extract_tier2("")
    assert out["solvent"] is None
    assert out["_status"]["solvent"]["status"] == "absent"


def test_tier2_handles_none_input():
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    out = extract_tier2(None)
    assert out["solvent"] is None


def test_tier2_no_catastrophic_backtracking():
    """100k-char procedure_text completes within 100 ms."""
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    huge = "x" * 100_000
    start = time.perf_counter()
    out = extract_tier2(huge)
    elapsed = time.perf_counter() - start
    assert elapsed < 0.1, f"Tier 2 took {elapsed:.3f}s on 100k input"
    assert out["solvent"] is None  # no matches in junk


def test_tier2_truncates_oversize_input():
    """Inputs over MAX_PROCEDURE_TEXT_LEN (100k) are dropped, not scanned."""
    from services.projectors.conditions_normalizer.extractors import extract_tier2
    text = ("y" * 100_001) + " in ethanol"
    out = extract_tier2(text)
    assert out["solvent"] is None  # cutoff prevented scan
