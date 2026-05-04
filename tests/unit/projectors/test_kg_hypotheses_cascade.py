"""Tranche 2 / C5: refutation cascade through kg_hypotheses.

When a hypothesis transitions to status='refuted', the projector must:
  1. Set valid_to + refuted=true on the :Hypothesis node (already covered
     by test_kg_hypotheses_idempotency).
  2. Walk every :CITES edge from the hypothesis and SET invalidated_at on
     each (additive bi-temporal closure).
  3. Emit one fact_invalidated event per closed edge so future projectors
     can react.
  4. Be idempotent on replay: a second pass over the same event closes
     no new edges and emits no new ingestion_events rows.
"""

from __future__ import annotations

import json
import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.projectors.kg_hypotheses.main import KgHypothesesProjector


class _FakeResult:
    """Async-iterable Neo4j result stand-in."""

    def __init__(self, records: list[dict[str, Any]]) -> None:
        self._records = list(records)

    def __aiter__(self) -> "_FakeResult":
        return self

    async def __anext__(self) -> dict[str, Any]:
        if not self._records:
            raise StopAsyncIteration
        return self._records.pop(0)


class _FakeSession:
    def __init__(self, cascade_records: list[dict[str, Any]]) -> None:
        self.runs: list[tuple[str, dict[str, Any]]] = []
        self.cascade_records = cascade_records

    async def __aenter__(self) -> "_FakeSession":
        return self

    async def __aexit__(self, *_args: Any) -> None:
        return None

    async def run(self, query: str, **params: Any) -> _FakeResult:
        self.runs.append((query, params))
        if "MATCH (h:Hypothesis {fact_id: $fid})-[r:CITES]" in query:
            recs = self.cascade_records
            self.cascade_records = []
            return _FakeResult(recs)
        return _FakeResult([])


class _FakeDriver:
    def __init__(self, session: _FakeSession) -> None:
        self.session_obj = session

    def session(self) -> _FakeSession:
        return self.session_obj


def _pg_status_connection(status: str) -> Any:
    cur = AsyncMock()
    cur.fetchone = AsyncMock(return_value=(status,))
    cur.__aenter__ = AsyncMock(return_value=cur)
    cur.__aexit__ = AsyncMock(return_value=None)

    conn = MagicMock()
    conn.cursor = MagicMock(return_value=cur)
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=None)
    return conn


def _pg_emit_connection() -> tuple[Any, list[tuple[str, tuple[Any, ...]]]]:
    captured: list[tuple[str, tuple[Any, ...]]] = []

    async def _capture_sql(sql: str, args: tuple[Any, ...] | None = None) -> None:
        captured.append((sql, tuple(args or ())))

    cur = AsyncMock()
    cur.execute = AsyncMock(side_effect=_capture_sql)
    cur.__aenter__ = AsyncMock(return_value=cur)
    cur.__aexit__ = AsyncMock(return_value=None)

    conn = MagicMock()
    conn.cursor = MagicMock(return_value=cur)
    conn.commit = AsyncMock()
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=None)
    return conn, captured


@pytest.mark.asyncio
async def test_refutation_cascades_invalidation_to_cites_edges_and_events() -> None:
    cascade_rows = [
        {
            "edge_fact_id": "11111111-1111-1111-1111-111111111111",
            "cited_fact_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        },
        {
            "edge_fact_id": "22222222-2222-2222-2222-222222222222",
            "cited_fact_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        },
    ]
    fake_session = _FakeSession(cascade_records=list(cascade_rows))

    settings = MagicMock()
    settings.postgres_dsn = "postgresql://stub"
    proj = KgHypothesesProjector.__new__(KgHypothesesProjector)
    proj.settings = settings  # type: ignore[attr-defined]
    proj._driver = _FakeDriver(fake_session)  # type: ignore[attr-defined]

    hid = str(uuid.uuid4())
    pg_status = _pg_status_connection("refuted")
    pg_emit, captured_inserts = _pg_emit_connection()
    connections = iter([pg_status, pg_emit])

    async def _connect(_dsn: str) -> Any:
        return next(connections)

    with patch("psycopg.AsyncConnection.connect", side_effect=_connect):
        await proj._handle_status_changed({"hypothesis_id": hid}, hid)

    cascade_runs = [
        (q, p) for (q, p) in fake_session.runs
        if "MATCH (h:Hypothesis {fact_id: $fid})-[r:CITES]" in q
    ]
    assert len(cascade_runs) == 1
    cascade_query = cascade_runs[0][0]
    assert "WHERE r.invalidated_at IS NULL" in cascade_query
    assert "SET r.invalidated_at" in cascade_query
    assert "RETURN r.fact_id" in cascade_query

    fact_invalidated_inserts = [
        (sql, args) for (sql, args) in captured_inserts
        if "INSERT INTO ingestion_events" in sql and "fact_invalidated" in sql
    ]
    assert len(fact_invalidated_inserts) == len(cascade_rows)
    for (sql, args), row in zip(fact_invalidated_inserts, cascade_rows):
        assert "'fact_invalidated'" in sql
        assert args[0] == hid
        payload = json.loads(args[1])
        assert payload["fact_id"] == row["cited_fact_id"]
        assert payload["edge_fact_id"] == row["edge_fact_id"]
        assert payload["invalidated_by"] == "hypothesis_refuted"
        assert payload["invalidated_by_hypothesis_id"] == hid


@pytest.mark.asyncio
async def test_replay_emits_no_new_events_when_cascade_is_empty() -> None:
    fake_session = _FakeSession(cascade_records=[])

    settings = MagicMock()
    settings.postgres_dsn = "postgresql://stub"
    proj = KgHypothesesProjector.__new__(KgHypothesesProjector)
    proj.settings = settings  # type: ignore[attr-defined]
    proj._driver = _FakeDriver(fake_session)  # type: ignore[attr-defined]

    hid = str(uuid.uuid4())
    pg_status = _pg_status_connection("refuted")
    connections = iter([pg_status])

    async def _connect(_dsn: str) -> Any:
        return next(connections)

    with patch("psycopg.AsyncConnection.connect", side_effect=_connect):
        await proj._handle_status_changed({"hypothesis_id": hid}, hid)

    assert next(connections, None) is None
