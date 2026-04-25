"""Tests for the kg_source_cache projector.

Neo4j / mcp-kg is stubbed — no live services required.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from unittest import mock

import pytest

from services.projectors.kg_source_cache.main import (
    KGSourceCacheProjector,
    Settings,
    _deterministic_fact_id,
)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _make_projector(kg_client: mock.AsyncMock | None = None) -> KGSourceCacheProjector:
    settings = Settings(
        postgres_host="localhost",
        postgres_port=5432,
        postgres_db="chemclaw",
        postgres_user="chemclaw",
        postgres_password="test",
        mcp_kg_url="http://localhost:8003",
        source_cache_ttl_days=7,
    )
    proj = KGSourceCacheProjector(settings)
    if kg_client is not None:
        proj._kg = kg_client
    return proj


def _future_ts(days: int = 7) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


def _past_ts(days: int = 1) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


# --------------------------------------------------------------------------
# Deterministic fact ID
# --------------------------------------------------------------------------
def test_deterministic_fact_id_is_stable():
    a = _deterministic_fact_id("ev1", "benchling", "HAS_YIELD", "exp_001", "87.5")
    b = _deterministic_fact_id("ev1", "benchling", "HAS_YIELD", "exp_001", "87.5")
    assert a == b


def test_deterministic_fact_id_differs_on_different_inputs():
    a = _deterministic_fact_id("ev1", "benchling", "HAS_YIELD", "exp_001", "87.5")
    b = _deterministic_fact_id("ev1", "benchling", "HAS_YIELD", "exp_002", "87.5")
    assert a != b


# --------------------------------------------------------------------------
# handle() — happy path
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_handle_calls_write_fact():
    kg = mock.AsyncMock()
    kg.write_fact.return_value = {"fact_id": "some-uuid"}
    proj = _make_projector(kg)

    await proj.handle(
        event_id="evt_aaa",
        event_type="source_fact_observed",
        source_table="ingestion_events",
        source_row_id="row_001",
        payload={
            "source_system_id": "benchling",
            "predicate": "HAS_YIELD",
            "subject_id": "exp_001",
            "object_value": 87.5,
            "source_system_timestamp": "2024-04-01T10:00:00Z",
            "fetched_at": "2024-04-01T10:01:00Z",
            "valid_until": _future_ts(7),
        },
    )

    kg.write_fact.assert_awaited_once()
    call_kwargs = kg.write_fact.call_args.kwargs
    assert call_kwargs["predicate"] == "HAS_YIELD"
    assert call_kwargs["source_type"] == "source_system"
    assert "benchling" in call_kwargs["source_id"]


@pytest.mark.asyncio
async def test_handle_uses_deterministic_fact_id():
    kg = mock.AsyncMock()
    kg.write_fact.return_value = {}
    proj = _make_projector(kg)

    payload = {
        "source_system_id": "starlims",
        "predicate": "HAS_PURITY",
        "subject_id": "smp_X",
        "object_value": 99.1,
        "fetched_at": "2024-04-01T12:00:00Z",
        "valid_until": _future_ts(),
    }

    await proj.handle(
        event_id="evt_bbb",
        event_type="source_fact_observed",
        source_table=None,
        source_row_id=None,
        payload=payload,
    )

    expected_fact_id = _deterministic_fact_id("evt_bbb", "starlims", "HAS_PURITY", "smp_X", "99.1")
    call_kwargs = kg.write_fact.call_args.kwargs
    assert call_kwargs["fact_id"] == expected_fact_id


@pytest.mark.asyncio
async def test_handle_defaults_valid_until_when_missing():
    kg = mock.AsyncMock()
    kg.write_fact.return_value = {}
    proj = _make_projector(kg)

    await proj.handle(
        event_id="evt_ccc",
        event_type="source_fact_observed",
        source_table=None,
        source_row_id=None,
        payload={
            "source_system_id": "waters",
            "predicate": "HAS_PEAK_AREA",
            "subject_id": "run_001",
            "object_value": 985000.0,
        },
    )

    call_kwargs = kg.write_fact.call_args.kwargs
    edge_props = call_kwargs["edge_properties"]
    valid_until_str = edge_props["valid_until"]
    valid_until_dt = datetime.fromisoformat(valid_until_str.replace("Z", "+00:00"))
    # Should be approximately 7 days from now
    delta = valid_until_dt - datetime.now(timezone.utc)
    assert timedelta(days=6) < delta < timedelta(days=8)


@pytest.mark.asyncio
async def test_handle_logs_warning_for_stale_fact(caplog):
    import logging
    kg = mock.AsyncMock()
    kg.write_fact.return_value = {}
    proj = _make_projector(kg)

    with caplog.at_level(logging.WARNING, logger="projector.kg_source_cache"):
        await proj.handle(
            event_id="evt_ddd",
            event_type="source_fact_observed",
            source_table=None,
            source_row_id=None,
            payload={
                "source_system_id": "benchling",
                "predicate": "HAS_YIELD",
                "subject_id": "exp_old",
                "object_value": 75.0,
                "valid_until": _past_ts(2),  # already expired
            },
        )

    # Should still call write_fact even for stale facts
    kg.write_fact.assert_awaited_once()
    assert any("stale" in r.message.lower() for r in caplog.records)


@pytest.mark.asyncio
async def test_handle_ignores_wrong_event_type():
    kg = mock.AsyncMock()
    proj = _make_projector(kg)

    await proj.handle(
        event_id="evt_eee",
        event_type="experiment_imported",  # wrong type
        source_table=None,
        source_row_id=None,
        payload={"some": "data"},
    )

    kg.write_fact.assert_not_awaited()
