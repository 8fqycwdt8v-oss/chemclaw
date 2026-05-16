"""Integration tests for the kg_source_cache → ingestion_events pipeline.

Requires a live Postgres (PG_DSN or POSTGRES_DSN env). Skipped when neither
is set. No Neo4j or mcp-kg needed; the projector's mcp-kg client is replaced
with an AsyncMock so the handler runs end-to-end against a real DB without
external services.

What is tested:
  1. UUID-cast contract: source_row_id in ingestion_events is a UUID column;
     inserting a non-UUID string must fail with a Postgres DataError.
  2. NULL source_row_id is allowed (the column is nullable).
  3. The projector handler acks a source_fact_observed event correctly.
  4. Replay idempotency: wipe acks → re-run → one ack, same KG call count.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock

import psycopg
import psycopg.errors
import pytest

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not (os.getenv("PG_DSN") or os.getenv("POSTGRES_DSN")),
        reason="requires PG_DSN or POSTGRES_DSN",
    ),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _dsn() -> str:
    return os.environ.get("PG_DSN") or os.environ["POSTGRES_DSN"]


@pytest.fixture
def pg_conn() -> Any:
    conn = psycopg.connect(_dsn())
    try:
        yield conn
    finally:
        conn.close()


def _insert_source_fact_event(
    conn: psycopg.Connection,
    *,
    source_row_id: str | None,
    payload: dict[str, Any] | None = None,
) -> uuid.UUID:
    event_id = uuid.uuid4()
    with conn.cursor() as cur:
        cur.execute("SET LOCAL ROLE chemclaw_service")
        cur.execute(
            """
            INSERT INTO ingestion_events
                   (id, event_type, source_table, source_row_id, payload)
            VALUES (%s::uuid, 'source_fact_observed', 'ingestion_events',
                    %s::uuid, %s::jsonb)
            """,
            (
                str(event_id),
                source_row_id,
                json.dumps(payload or {}),
            ),
        )
    conn.commit()
    return event_id


def _make_projector() -> Any:
    from services.projectors.kg_source_cache.main import KGSourceCacheProjector, Settings

    settings = Settings(
        postgres_host="localhost",
        postgres_password="fake",
        mcp_kg_url="http://mcp-kg:8003",
    )
    proj = KGSourceCacheProjector(settings)
    return proj


def _mock_kg() -> AsyncMock:
    kg = AsyncMock()
    kg.write_fact.return_value = {"fact_id": str(uuid.uuid4())}
    return kg


def _future_ts(days: int = 7) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


# ---------------------------------------------------------------------------
# UUID-cast schema contract tests
# ---------------------------------------------------------------------------


def test_valid_uuid_source_row_id_inserts_successfully(pg_conn: psycopg.Connection) -> None:
    """A valid UUID string as source_row_id succeeds."""
    event_id = _insert_source_fact_event(
        pg_conn,
        source_row_id=str(uuid.uuid4()),
        payload={"source_system_id": "test"},
    )
    with pg_conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM ingestion_events WHERE id = %s::uuid",
            (str(event_id),),
        )
        row = cur.fetchone()
    assert row is not None


def test_null_source_row_id_inserts_successfully(pg_conn: psycopg.Connection) -> None:
    """NULL is allowed for source_row_id (the column is nullable)."""
    event_id = _insert_source_fact_event(
        pg_conn,
        source_row_id=None,
        payload={"source_system_id": "test"},
    )
    with pg_conn.cursor() as cur:
        cur.execute(
            "SELECT source_row_id FROM ingestion_events WHERE id = %s::uuid",
            (str(event_id),),
        )
        row = cur.fetchone()
    assert row is not None
    assert row[0] is None


def test_non_uuid_source_row_id_raises_data_error(pg_conn: psycopg.Connection) -> None:
    """A non-UUID string (e.g. an ELN entry ID) must raise Postgres DataError.

    This pins the UUID-column contract on ingestion_events.source_row_id.
    If the column is ever changed to TEXT or the helper removes the ::uuid cast,
    this test will fail and the regression will be caught at PR time.
    """
    with pytest.raises(psycopg.errors.InvalidTextRepresentation):
        _insert_source_fact_event(
            pg_conn,
            source_row_id="ELN-ENTRY-12345",  # not a UUID
        )
    pg_conn.rollback()


# ---------------------------------------------------------------------------
# Projector handler ack tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_projector_acks_source_fact_event(pg_conn: psycopg.Connection) -> None:
    """Handler runs against a real Postgres row and acks the event."""
    import asyncio

    proj = _make_projector()
    proj._kg = _mock_kg()

    payload = {
        "source_system_id": "benchling-test",
        "predicate": "HAS_YIELD",
        "subject_id": str(uuid.uuid4()),
        "object_value": 87.5,
        "source_system_timestamp": "2024-04-01T10:00:00Z",
        "fetched_at": "2024-04-01T10:01:00Z",
        "valid_until": _future_ts(7),
    }
    event_id = _insert_source_fact_event(
        pg_conn,
        source_row_id=None,
        payload=payload,
    )

    async def _catch_up() -> None:
        from services.projectors.common.base import ProjectorSettings
        settings = ProjectorSettings()
        async with await psycopg.AsyncConnection.connect(settings.postgres_dsn) as work:
            await proj._catch_up(work)

    asyncio.run(_catch_up())

    with pg_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*)::int FROM projection_acks "
            "WHERE projector_name = %s AND event_id = %s::uuid",
            ("kg_source_cache", str(event_id)),
        )
        row = cur.fetchone()
    assert row and row[0] == 1
    proj._kg.write_fact.assert_awaited_once()


@pytest.mark.asyncio
async def test_projector_replay_is_idempotent(pg_conn: psycopg.Connection) -> None:
    """Wipe acks → re-run → one ack row, no duplicate KG calls."""
    import asyncio

    proj = _make_projector()
    proj._kg = _mock_kg()

    payload = {
        "source_system_id": "benchling-replay",
        "predicate": "HAS_PURITY",
        "subject_id": str(uuid.uuid4()),
        "object_value": 99.2,
        "source_system_timestamp": "2024-04-02T08:00:00Z",
        "fetched_at": "2024-04-02T08:01:00Z",
        "valid_until": _future_ts(7),
    }
    event_id = _insert_source_fact_event(
        pg_conn,
        source_row_id=None,
        payload=payload,
    )

    from services.projectors.common.base import ProjectorSettings
    settings = ProjectorSettings()

    async def _catch_up() -> None:
        async with await psycopg.AsyncConnection.connect(settings.postgres_dsn) as work:
            await proj._catch_up(work)

    asyncio.run(_catch_up())

    with pg_conn.cursor() as cur:
        cur.execute("SET LOCAL ROLE chemclaw_service")
        cur.execute(
            "DELETE FROM projection_acks WHERE projector_name = 'kg_source_cache'",
        )
    pg_conn.commit()

    proj._kg.reset_mock()
    asyncio.run(_catch_up())

    with pg_conn.cursor() as cur:
        cur.execute(
            "SELECT count(*)::int FROM projection_acks "
            "WHERE projector_name = %s AND event_id = %s::uuid",
            ("kg_source_cache", str(event_id)),
        )
        row = cur.fetchone()
    assert row and row[0] == 1
    proj._kg.write_fact.assert_awaited_once()
