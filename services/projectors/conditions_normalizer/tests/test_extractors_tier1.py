"""Tier 1 (direct JSONB copy) extraction tests."""
from __future__ import annotations


def test_tier1_extracts_solvent_and_temp():
    from services.projectors.conditions_normalizer.extractors import extract_tier1
    out = extract_tier1(
        tabular_data={"solvent": "EtOH", "temp_c": 80, "time_min": 240},
        mock_eln_fields={},
    )
    assert out["solvent"] == "EtOH"
    assert out["temperature_c"] == 80.0
    assert out["time_min"] == 240.0
    assert out["_status"]["solvent"]["status"] == "extracted"
    assert out["_status"]["solvent"]["source"] == "tabular_data"
    assert out["_status"]["temperature_c"]["source"] == "tabular_data"


def test_tier1_mock_eln_fallback_when_tabular_empty():
    from services.projectors.conditions_normalizer.extractors import extract_tier1
    out = extract_tier1(
        tabular_data={},
        mock_eln_fields={"solvent": "DMF", "catalyst_smiles": "[Pd]"},
    )
    assert out["solvent"] == "DMF"
    assert out["catalyst_smiles"] == "[Pd]"
    assert out["_status"]["solvent"]["source"] == "mock_eln_fields_jsonb"


def test_tier1_tabular_takes_precedence_over_mock_eln():
    """tabular_data wins when both populated — it's the canonical column."""
    from services.projectors.conditions_normalizer.extractors import extract_tier1
    out = extract_tier1(
        tabular_data={"solvent": "EtOAc"},
        mock_eln_fields={"solvent": "DMF"},
    )
    assert out["solvent"] == "EtOAc"
    assert out["_status"]["solvent"]["source"] == "tabular_data"


def test_tier1_temperature_alias_keys():
    """Both 'temp_c' and 'temperature_c' map to temperature_c."""
    from services.projectors.conditions_normalizer.extractors import extract_tier1
    out_a = extract_tier1(tabular_data={"temp_c": 100}, mock_eln_fields={})
    out_b = extract_tier1(tabular_data={"temperature_c": 100}, mock_eln_fields={})
    assert out_a["temperature_c"] == 100.0
    assert out_b["temperature_c"] == 100.0


def test_tier1_invalid_temperature_dropped():
    """Non-numeric temperature is dropped; status records 'absent'."""
    from services.projectors.conditions_normalizer.extractors import extract_tier1
    out = extract_tier1(
        tabular_data={"temp_c": "hot"},
        mock_eln_fields={},
    )
    assert out.get("temperature_c") is None
    assert out["_status"]["temperature_c"]["status"] == "absent"


def test_tier1_atmosphere_normalized():
    """Free-form atmosphere strings → canonical 'air'/'N2'/'Ar'/'O2'."""
    from services.projectors.conditions_normalizer.extractors import extract_tier1
    cases = [("argon", "Ar"), ("nitrogen", "N2"), ("AIR", "air"), ("oxygen", "O2"), ("ar", "Ar")]
    for raw, expected in cases:
        out = extract_tier1(tabular_data={"atmosphere": raw}, mock_eln_fields={})
        assert out["atmosphere"] == expected, (
            f"{raw!r} → {out.get('atmosphere')!r}, expected {expected!r}"
        )


def test_tier1_handles_corrupted_jsonb_gracefully():
    """If passed None or non-dict JSONB, extractor returns empty result."""
    from services.projectors.conditions_normalizer.extractors import extract_tier1
    out = extract_tier1(tabular_data=None, mock_eln_fields=None)
    assert out["solvent"] is None
    # Status should mark all fields absent — _status is populated
    assert all(s.get("status") == "absent" for s in out["_status"].values())
