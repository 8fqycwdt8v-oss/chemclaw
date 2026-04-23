"""Integration test for the kg-hypotheses projector.

Gated by pytest.mark.integration so it runs only when NEO4J_URI is set.
"""
from __future__ import annotations

import json
import os
import uuid

import psycopg
import pytest

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.getenv("NEO4J_URI"),
        reason="requires live Neo4j (set NEO4J_URI)",
    ),
]


@pytest.fixture
def neo4j_driver():
    """Synchronous Neo4j driver constructed from env vars.

    Only consumed when NEO4J_URI is present; the skipif marker above
    guarantees this fixture is never reached when the env is absent.
    """
    import neo4j  # type: ignore[import-untyped]

    uri = os.environ["NEO4J_URI"]
    user = os.environ.get("NEO4J_USER", "neo4j")
    password = os.environ["NEO4J_PASSWORD"]
    driver = neo4j.GraphDatabase.driver(uri, auth=(user, password))
    try:
        yield driver
    finally:
        driver.close()


def test_hypothesis_proposed_projects_node_and_cites_edges(pg_conn: psycopg.Connection, neo4j_driver) -> None:
    # Insert a hypothesis row + citation row + ingestion_event.
    hid = uuid.uuid4()
    fid = uuid.uuid4()
    with pg_conn.cursor() as cur:
        cur.execute("SET LOCAL ROLE chemclaw_service")
        cur.execute(
            "INSERT INTO hypotheses (id, hypothesis_text, confidence, proposed_by_user_entra_id) "
            "VALUES (%s, %s, %s, %s)",
            (str(hid), "Cross-project correlation hypothesis for test.", 0.8, "user-a"),
        )
        cur.execute(
            "INSERT INTO hypothesis_citations (hypothesis_id, fact_id) VALUES (%s, %s)",
            (str(hid), str(fid)),
        )
        cur.execute(
            "INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload) "
            "VALUES (%s, %s, %s, %s::jsonb)",
            ("hypothesis_proposed", "hypotheses", str(hid), json.dumps({"hypothesis_id": str(hid)})),
        )
    pg_conn.commit()

    # Run projector catch-up (one iteration).
    from services.projectors.kg_hypotheses.main import KgHypothesesProjector
    from services.projectors.common.base import ProjectorSettings

    settings = ProjectorSettings()  # loads env
    proj = KgHypothesesProjector(settings)

    # Use the internal _catch_up directly — deterministic, no NOTIFY wait.
    import asyncio

    async def _run() -> None:
        async with await psycopg.AsyncConnection.connect(settings.postgres_dsn) as work:
            await proj._catch_up(work)

    asyncio.run(_run())

    # Verify Neo4j state.
    with neo4j_driver.session() as session:
        rec = session.run(
            "MATCH (h:Hypothesis) WHERE h.hypothesis_id = $hid "
            "OPTIONAL MATCH (h)-[c:CITES]->(f) RETURN h.text AS text, count(c) AS cites",
            hid=str(hid),
        ).single()
        assert rec is not None
        assert rec["text"].startswith("Cross-project")
        assert rec["cites"] >= 1  # CITES edge exists (to Fact or ungrounded placeholder)


def test_replay_is_idempotent(pg_conn: psycopg.Connection, neo4j_driver) -> None:
    # Insert + run twice; Neo4j node count should stay the same.
    hid = uuid.uuid4()
    with pg_conn.cursor() as cur:
        cur.execute("SET LOCAL ROLE chemclaw_service")
        cur.execute(
            "INSERT INTO hypotheses (id, hypothesis_text, confidence, proposed_by_user_entra_id) "
            "VALUES (%s, %s, %s, %s)",
            (str(hid), "Replay idempotency test hypothesis.", 0.6, "user-a"),
        )
        cur.execute(
            "INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload) "
            "VALUES (%s, %s, %s, %s::jsonb)",
            ("hypothesis_proposed", "hypotheses", str(hid), json.dumps({"hypothesis_id": str(hid)})),
        )
        # Wipe acks so catch-up picks it up on both runs.
        cur.execute("DELETE FROM projection_acks WHERE projector_name = 'kg-hypotheses'")
    pg_conn.commit()

    from services.projectors.kg_hypotheses.main import KgHypothesesProjector
    from services.projectors.common.base import ProjectorSettings
    import asyncio

    settings = ProjectorSettings()
    proj = KgHypothesesProjector(settings)

    async def _run() -> None:
        async with await psycopg.AsyncConnection.connect(settings.postgres_dsn) as work:
            await proj._catch_up(work)

    asyncio.run(_run())
    with pg_conn.cursor() as cur:
        cur.execute("DELETE FROM projection_acks WHERE projector_name = 'kg-hypotheses'")
    pg_conn.commit()
    asyncio.run(_run())

    with neo4j_driver.session() as session:
        rec = session.run(
            "MATCH (h:Hypothesis) WHERE h.hypothesis_id = $hid RETURN count(h) AS n",
            hid=str(hid),
        ).single()
        assert rec["n"] == 1
