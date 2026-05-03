"""Skeleton-level tests for the conditions_normalizer projector."""
from __future__ import annotations


def test_projector_class_metadata():
    from services.projectors.conditions_normalizer.main import (  # noqa: PLC0415
        ConditionsNormalizer,
    )
    assert ConditionsNormalizer.name == "conditions_normalizer"
    assert ConditionsNormalizer.interested_event_types == ("experiment_imported",)


def test_projector_settings_defaults():
    from services.projectors.conditions_normalizer.main import Settings  # noqa: PLC0415
    s = Settings(_env_file=None)
    assert s.mcp_rdkit_url.startswith("http")
    assert s.conditions_normalizer_llm_fallback in (True, False)
