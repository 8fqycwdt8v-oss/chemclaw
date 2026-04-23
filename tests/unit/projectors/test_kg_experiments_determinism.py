"""Unit tests for the deterministic fact_id generation in kg_experiments.

We don't test the full DB round-trip here; that's an integration test. We do
test the pure helpers — determinism of fact_id generation is critical for
idempotent replay.
"""

from __future__ import annotations

from services.projectors.kg_experiments.main import (
    _deterministic_fact_id,
    _short_hash,
)


def test_fact_id_is_deterministic() -> None:
    a = _deterministic_fact_id("PART_OF_PROJECT", "step-1", "NCE-001")
    b = _deterministic_fact_id("PART_OF_PROJECT", "step-1", "NCE-001")
    assert a == b


def test_fact_id_differs_on_any_change() -> None:
    base = _deterministic_fact_id("PART_OF_PROJECT", "step-1", "NCE-001")
    assert base != _deterministic_fact_id("PART_OF_STEP", "step-1", "NCE-001")
    assert base != _deterministic_fact_id("PART_OF_PROJECT", "step-2", "NCE-001")
    assert base != _deterministic_fact_id("PART_OF_PROJECT", "step-1", "NCE-002")


def test_short_hash_is_stable_and_short() -> None:
    v = _short_hash("4-bromobenzonitrile")
    assert len(v) == 16
    assert v == _short_hash("4-bromobenzonitrile")
    assert v != _short_hash("phenylboronic acid")
