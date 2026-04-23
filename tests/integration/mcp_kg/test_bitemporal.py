"""Integration tests: mcp-kg driver against a live Neo4j.

Skipped unless NEO4J_INTEGRATION=1 is in the environment. Use:

    NEO4J_INTEGRATION=1 pytest tests/integration/mcp_kg/ -v

Requires `docker compose up -d neo4j` to be running first.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
import pytest_asyncio

from services.mcp_tools.mcp_kg.driver import KGDriver
from services.mcp_tools.mcp_kg.models import (
    ConfidenceTier,
    EntityRef,
    InvalidateFactRequest,
    Provenance,
    QueryAtTimeRequest,
    WriteFactRequest,
)

pytestmark = pytest.mark.skipif(
    os.environ.get("NEO4J_INTEGRATION") != "1",
    reason="set NEO4J_INTEGRATION=1 with Neo4j running to enable",
)


@pytest_asyncio.fixture
async def driver() -> KGDriver:
    uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    user = os.environ.get("NEO4J_USER", "neo4j")
    password = os.environ.get("NEO4J_PASSWORD", "chemclaw_dev_neo4j_change_me")
    d = KGDriver(uri=uri, user=user, password=password)
    await d.verify()

    # Scope every test to its own namespace via label suffix.
    async with d._driver.session() as session:  # type: ignore[attr-defined]
        await session.run("MATCH (n:ITestNode) DETACH DELETE n")

    try:
        yield d
    finally:
        async with d._driver.session() as session:  # type: ignore[attr-defined]
            await session.run("MATCH (n:ITestNode) DETACH DELETE n")
        await d.close()


def _prov() -> Provenance:
    return Provenance(source_type="ELN", source_id="itest-001")


@pytest.mark.asyncio
async def test_write_and_query_roundtrip(driver: KGDriver) -> None:
    req = WriteFactRequest(
        subject=EntityRef(label="ITestNode", id_property="internal_id", id_value="A"),
        object=EntityRef(label="ITestNode", id_property="internal_id", id_value="B"),
        predicate="RELATES_TO",
        edge_properties={"weight": 0.9},
        confidence_tier=ConfidenceTier.MULTI_SOURCE_LLM,
        confidence_score=0.8,
        provenance=_prov(),
    )
    res = await driver.write_fact(req)
    assert res.created is True
    assert res.fact_id is not None

    q = await driver.query_at_time(
        QueryAtTimeRequest(
            entity=EntityRef(label="ITestNode", id_property="internal_id", id_value="A"),
            direction="out",
        )
    )
    assert len(q.facts) == 1
    f = q.facts[0]
    assert f.predicate == "RELATES_TO"
    assert f.object.id_value == "B"
    assert f.confidence_tier == ConfidenceTier.MULTI_SOURCE_LLM
    assert f.edge_properties == {"weight": 0.9}
    assert f.t_valid_to is None


@pytest.mark.asyncio
async def test_idempotent_write_with_fact_id(driver: KGDriver) -> None:
    fid = uuid4()
    req = WriteFactRequest(
        subject=EntityRef(label="ITestNode", id_property="internal_id", id_value="X"),
        object=EntityRef(label="ITestNode", id_property="internal_id", id_value="Y"),
        predicate="RELATES_TO",
        provenance=_prov(),
        fact_id=fid,
    )
    first = await driver.write_fact(req)
    second = await driver.write_fact(req)
    assert first.created is True
    assert second.created is False
    assert first.fact_id == second.fact_id == fid


@pytest.mark.asyncio
async def test_invalidate_fact_sets_t_valid_to(driver: KGDriver) -> None:
    written = await driver.write_fact(
        WriteFactRequest(
            subject=EntityRef(label="ITestNode", id_property="internal_id", id_value="P"),
            object=EntityRef(label="ITestNode", id_property="internal_id", id_value="Q"),
            predicate="RELATES_TO",
            provenance=_prov(),
        )
    )
    inv = await driver.invalidate_fact(
        InvalidateFactRequest(
            fact_id=written.fact_id,
            reason="superseded by new evidence",
            invalidated_by_provenance=_prov(),
        )
    )
    assert inv.was_already_invalid is False
    # A second invalidate is a no-op on the times.
    inv2 = await driver.invalidate_fact(
        InvalidateFactRequest(
            fact_id=written.fact_id,
            reason="still wrong",
            invalidated_by_provenance=_prov(),
        )
    )
    assert inv2.was_already_invalid is True


@pytest.mark.asyncio
async def test_query_at_time_is_temporal(driver: KGDriver) -> None:
    past = datetime.now(timezone.utc) - timedelta(days=30)
    future = datetime.now(timezone.utc) + timedelta(days=30)

    written = await driver.write_fact(
        WriteFactRequest(
            subject=EntityRef(label="ITestNode", id_property="internal_id", id_value="M"),
            object=EntityRef(label="ITestNode", id_property="internal_id", id_value="N"),
            predicate="RELATES_TO",
            t_valid_from=past,
            provenance=_prov(),
        )
    )

    # At 10 days ago → fact should be visible.
    ten_days_ago = datetime.now(timezone.utc) - timedelta(days=10)
    q1 = await driver.query_at_time(
        QueryAtTimeRequest(
            entity=EntityRef(label="ITestNode", id_property="internal_id", id_value="M"),
            direction="out",
            at_time=ten_days_ago,
        )
    )
    assert len(q1.facts) == 1

    # Invalidate at "now" ⇒ fact should NOT be visible at `future`.
    await driver.invalidate_fact(
        InvalidateFactRequest(
            fact_id=written.fact_id,
            reason="test",
            invalidated_by_provenance=_prov(),
        )
    )

    q2 = await driver.query_at_time(
        QueryAtTimeRequest(
            entity=EntityRef(label="ITestNode", id_property="internal_id", id_value="M"),
            direction="out",
            at_time=future,
            include_invalidated=False,
        )
    )
    # fact is invalidated (invalidated_at != null) ⇒ excluded by default
    assert q2.facts == []

    # With include_invalidated=True we see it again.
    q3 = await driver.query_at_time(
        QueryAtTimeRequest(
            entity=EntityRef(label="ITestNode", id_property="internal_id", id_value="M"),
            direction="out",
            include_invalidated=True,
        )
    )
    assert len(q3.facts) == 1
    assert q3.facts[0].t_valid_to is not None
