"""Tranche 3 / H4: TestClient coverage for the POST /tools/get_fact_provenance route.

We mount the existing FastAPI app, inject a mock KGDriver into the
module-level holder, and exercise the route surface (200 happy path
+ 404 on missing fact_id). This is enough to give diff-cover the
coverage credit for the route body.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from services.mcp_tools.mcp_kg.models import (
    ConfidenceTier,
    EntityRef,
    GetFactProvenanceResponse,
    Provenance,
)


FACT_ID = UUID("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")


def _make_response() -> GetFactProvenanceResponse:
    return GetFactProvenanceResponse(
        fact_id=FACT_ID,
        subject=EntityRef(label="Compound", id_property="inchikey", id_value="KEY1"),
        predicate="HAS_YIELD",
        object=EntityRef(label="YieldMeasurement", id_property="id", id_value="ym-1"),
        provenance=Provenance(source_type="ELN", source_id="ELN-42"),
        confidence_tier=ConfidenceTier.MULTI_SOURCE_LLM,
        confidence_score=0.82,
        t_valid_from=datetime(2026, 1, 1, tzinfo=timezone.utc),
        t_valid_to=None,
        recorded_at=datetime(2026, 1, 2, tzinfo=timezone.utc),
        invalidated_at=None,
        invalidation_reason=None,
    )


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> Any:
    # Dev mode bypasses the MCP bearer-token requirement so we don't need
    # a signed JWT for the test request.
    monkeypatch.setenv("MCP_AUTH_DEV_MODE", "true")

    from services.mcp_tools.mcp_kg import main as kg_main

    # Stub the driver holder. The lifespan would normally fill this with
    # a real KGDriver pointed at Neo4j; we install a mock so the route
    # body executes without opening a Bolt session.
    fake_driver = AsyncMock()
    fake_driver.get_fact_provenance = AsyncMock(return_value=_make_response())
    monkeypatch.setitem(kg_main._driver_holder, "driver", fake_driver)  # type: ignore[arg-type]

    with TestClient(kg_main.app) as c:
        # The lifespan ran and may have overwritten our injection — re-install.
        monkeypatch.setitem(kg_main._driver_holder, "driver", fake_driver)  # type: ignore[arg-type]
        yield c, fake_driver


def test_get_fact_provenance_route_returns_200(client: Any) -> None:
    c, _drv = client
    r = c.post(
        "/tools/get_fact_provenance",
        json={"fact_id": str(FACT_ID), "group_id": "proj-NCE-007"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["fact_id"] == str(FACT_ID)
    assert body["predicate"] == "HAS_YIELD"
    assert body["provenance"]["source_id"] == "ELN-42"
    assert body["confidence_tier"] == "multi_source_llm"


def test_get_fact_provenance_route_returns_404_on_missing_fact(
    client: Any,
) -> None:
    c, drv = client
    drv.get_fact_provenance.side_effect = LookupError(f"fact_id {FACT_ID} not found")
    r = c.post(
        "/tools/get_fact_provenance",
        json={"fact_id": str(FACT_ID)},
    )
    assert r.status_code == 404, r.text


def test_get_fact_provenance_route_rejects_invalid_uuid(client: Any) -> None:
    c, _drv = client
    r = c.post("/tools/get_fact_provenance", json={"fact_id": "not-a-uuid"})
    assert r.status_code in (400, 422), r.text
