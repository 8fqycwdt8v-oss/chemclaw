"""Tests for the unified 3-tier composer."""
from __future__ import annotations


def test_compose_tier1_wins_when_complete():
    from services.projectors.conditions_normalizer.extractors import compose_extractions
    t1 = {
        "solvent": "EtOH", "temperature_c": 80.0,
        "_status": {
            "solvent": {"status": "extracted", "source": "tabular_data"},
            "temperature_c": {"status": "extracted", "source": "tabular_data"},
        },
    }
    t2 = {
        "solvent": "DCM", "temperature_c": 25.0,
        "_status": {
            "solvent": {"status": "extracted", "source": "regex"},
            "temperature_c": {"status": "extracted", "source": "regex"},
        },
    }
    out = compose_extractions(t1, t2, None)
    assert out["solvent"] == "EtOH"  # tier1 wins
    assert out["temperature_c"] == 80.0
    assert out["extraction_status"]["solvent"]["source"] == "tabular_data"
    assert out["conditions_extracted_from"] == "tabular_data"


def test_compose_tier2_fills_tier1_gap():
    from services.projectors.conditions_normalizer.extractors import compose_extractions
    t1 = {
        "solvent": None, "temperature_c": 80.0,
        "_status": {
            "solvent": {"status": "absent"},
            "temperature_c": {"status": "extracted", "source": "tabular_data"},
        },
    }
    t2 = {
        "solvent": "DCM", "temperature_c": None,
        "_status": {
            "solvent": {"status": "extracted", "source": "regex"},
            "temperature_c": {"status": "absent"},
        },
    }
    out = compose_extractions(t1, t2, None)
    assert out["solvent"] == "DCM"
    assert out["temperature_c"] == 80.0
    assert out["extraction_status"]["solvent"]["source"] == "regex"
    # Highest-priority source that contributed any value.
    assert out["conditions_extracted_from"] == "tabular_data"


def test_compose_tier3_fills_residual():
    from services.projectors.conditions_normalizer.extractors import compose_extractions
    t1 = {
        "solvent": None, "temperature_c": None,
        "_status": {"solvent": {"status": "absent"}, "temperature_c": {"status": "absent"}},
    }
    t2 = {
        "solvent": None, "temperature_c": None,
        "_status": {"solvent": {"status": "absent"}, "temperature_c": {"status": "absent"}},
    }
    t3 = {
        "solvent": "Toluene", "temperature_c": 110.0,
        "_status": {
            "solvent": {"status": "extracted", "source": "llm"},
            "temperature_c": {"status": "extracted", "source": "llm"},
        },
    }
    out = compose_extractions(t1, t2, t3)
    assert out["solvent"] == "Toluene"
    assert out["temperature_c"] == 110.0
    assert out["conditions_extracted_from"] == "llm"


def test_compose_all_absent_returns_none_source():
    from services.projectors.conditions_normalizer.extractors import compose_extractions
    t1 = {"solvent": None, "_status": {"solvent": {"status": "absent"}}}
    t2 = {"solvent": None, "_status": {"solvent": {"status": "absent"}}}
    out = compose_extractions(t1, t2, None)
    assert out["solvent"] is None
    assert out["conditions_extracted_from"] == "none"


def test_compose_handles_missing_t3():
    from services.projectors.conditions_normalizer.extractors import compose_extractions
    t1 = {
        "solvent": "EtOH",
        "_status": {"solvent": {"status": "extracted", "source": "tabular_data"}},
    }
    t2 = {"solvent": None, "_status": {"solvent": {"status": "absent"}}}
    out = compose_extractions(t1, t2, None)  # tier3 disabled by config
    assert out["solvent"] == "EtOH"
