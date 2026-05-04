"""Tranche 3 / H4: unit test for KGDriver.get_fact_provenance().

We mock the Neo4j async session so the test runs without a live driver.
The goals are coverage of (a) happy-path response construction, (b)
LookupError on missing fact_id, and (c) cross-tenant isolation.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

import pytest

from services.mcp_tools.mcp_kg.driver import KGDriver
from services.mcp_tools.mcp_kg.models import (
    ConfidenceTier,
    GetFactProvenanceRequest,
)


FACT_ID = UUID("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")


def _row_with_node_props() -> dict[str, Any]:
    """A representative Neo4j row dict the driver expects."""
    return {
        "predicate": "HAS_YIELD",
        "s_labels": ["Compound"],
        "o_labels": ["YieldMeasurement"],
        "s_props": {"inchikey": "KEY1", "name": "compound A"},
        "o_props": {"id": "ym-1"},
        "t_valid_from": datetime(2026, 1, 1, tzinfo=timezone.utc),
        "t_valid_to": None,
        "recorded_at": datetime(2026, 1, 2, tzinfo=timezone.utc),
        "invalidated_at": None,
        "invalidation_reason": None,
        "confidence_tier": "multi_source_llm",
        "confidence_score": 0.82,
        "provenance": '{"source_type": "ELN", "source_id": "ELN-42"}',
    }


def _make_driver_with_session(row: dict[str, Any] | None) -> KGDriver:
    """Construct a KGDriver whose internal _driver yields a session whose
    `run().single()` returns the supplied row (or None for the not-found
    case)."""
    drv = KGDriver.__new__(KGDriver)

    fake_result = AsyncMock()
    fake_result.single = AsyncMock(return_value=row)

    fake_session = MagicMock()
    fake_session.run = AsyncMock(return_value=fake_result)
    fake_session.__aenter__ = AsyncMock(return_value=fake_session)
    fake_session.__aexit__ = AsyncMock(return_value=None)

    fake_neo4j = MagicMock()
    fake_neo4j.session = MagicMock(return_value=fake_session)
    drv._driver = fake_neo4j  # type: ignore[attr-defined]
    return drv


@pytest.mark.asyncio
async def test_get_fact_provenance_returns_full_envelope() -> None:
    drv = _make_driver_with_session(_row_with_node_props())
    resp = await drv.get_fact_provenance(
        GetFactProvenanceRequest(fact_id=FACT_ID, group_id="proj-NCE-007")
    )

    assert resp.fact_id == FACT_ID
    assert resp.predicate == "HAS_YIELD"
    assert resp.subject.label == "Compound"
    assert resp.subject.id_property == "inchikey"
    assert resp.subject.id_value == "KEY1"
    assert resp.object.label == "YieldMeasurement"
    assert resp.object.id_property == "id"
    assert resp.object.id_value == "ym-1"
    assert resp.confidence_tier is ConfidenceTier.MULTI_SOURCE_LLM
    assert resp.confidence_score == pytest.approx(0.82)
    assert resp.provenance.source_type == "ELN"
    assert resp.provenance.source_id == "ELN-42"
    assert resp.t_valid_to is None
    assert resp.invalidated_at is None
    assert resp.invalidation_reason is None


@pytest.mark.asyncio
async def test_get_fact_provenance_propagates_invalidation_metadata() -> None:
    row = _row_with_node_props()
    row["invalidated_at"] = datetime(2026, 4, 1, tzinfo=timezone.utc)
    row["invalidation_reason"] = "hypothesis_refuted"
    row["t_valid_to"] = datetime(2026, 4, 1, tzinfo=timezone.utc)
    drv = _make_driver_with_session(row)

    resp = await drv.get_fact_provenance(
        GetFactProvenanceRequest(fact_id=FACT_ID)
    )
    assert resp.invalidated_at is not None
    assert resp.invalidation_reason == "hypothesis_refuted"
    assert resp.t_valid_to is not None


@pytest.mark.asyncio
async def test_get_fact_provenance_raises_lookup_error_for_unknown_fact() -> None:
    drv = _make_driver_with_session(None)
    with pytest.raises(LookupError, match=str(FACT_ID)):
        await drv.get_fact_provenance(
            GetFactProvenanceRequest(fact_id=FACT_ID)
        )


@pytest.mark.asyncio
async def test_get_fact_provenance_passes_group_id_to_cypher() -> None:
    drv = _make_driver_with_session(_row_with_node_props())
    await drv.get_fact_provenance(
        GetFactProvenanceRequest(fact_id=FACT_ID, group_id="proj-NCE-007")
    )
    # Inspect the Cypher params handed to session.run.
    fake_session = drv._driver.session.return_value  # type: ignore[attr-defined]
    call = fake_session.run.await_args_list[0]
    _query, params = call.args
    assert params["fact_id"] == str(FACT_ID)
    assert params["group_id"] == "proj-NCE-007"
