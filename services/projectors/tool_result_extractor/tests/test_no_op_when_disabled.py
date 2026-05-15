"""
Phase 0 guarantee: the projector starts cleanly and processes
`tool_invocation_complete` events as no-ops when the extraction_registry
has no matching row. Zero facts must be emitted; the event must be ack'd
(implicit via handle() returning without raising).
"""
from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, patch

import psycopg
import pytest

from services.projectors.common.base import ProjectorSettings
from services.projectors.tool_result_extractor.main import ToolResultExtractor


# ---------------------------------------------------------------------------
# Fake async-Postgres plumbing (mirrors tests/unit/projectors/test_wiki_pages)
# ---------------------------------------------------------------------------


class _FakeCursor:
    def __init__(self, conn: "_FakeConn") -> None:
        self._conn = conn

    async def __aenter__(self) -> "_FakeCursor":
        return self

    async def __aexit__(self, *_a: Any) -> bool:
        return False

    async def execute(self, sql: str, params: Any = None) -> None:
        self._conn.calls.append((sql, params))
        if sql.lstrip().upper().startswith("SELECT") or "RETURNING" in sql.upper():
            self._conn._last_select_sql = sql

    async def fetchone(self) -> Any:
        return self._conn.next_fetchone()


class _FakeConn:
    def __init__(self, fetchone_queue: list[Any] | None = None) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.committed = 0
        self._fetchone_queue = list(fetchone_queue or [])
        self._last_select_sql = ""

    async def __aenter__(self) -> "_FakeConn":
        return self

    async def __aexit__(self, *_a: Any) -> bool:
        return False

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self)

    async def commit(self) -> None:
        self.committed += 1

    def next_fetchone(self) -> Any:
        if not self._fetchone_queue:
            return None
        return self._fetchone_queue.pop(0)

    def sql_calls(self) -> list[str]:
        return [s for (s, _p) in self.calls]


def _settings() -> ProjectorSettings:
    return ProjectorSettings(_env_file=None, postgres_password="x")  # type: ignore[call-arg]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_op_when_registry_empty() -> None:
    """Registry miss → handle() returns without inserting any facts."""
    conn = _FakeConn(fetchone_queue=[None])  # registry SELECT → no row
    projector = ToolResultExtractor(_settings())

    payload = {
        "tool_name": "mcp-xtb.compute_barrier",
        "user_entra_id": "u1",
        "project_id": str(uuid.uuid4()),
        "result_schema_id": "v1",
        "args": {"smiles": "[redacted]"},
        "result": {"barrier_kj_mol": 92.3},
        "duration_ms": 1234,
        "ok": True,
        "error": None,
    }
    with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=conn)):
        await projector.handle(
            event_id="evt-1",
            event_type="tool_invocation_complete",
            source_table="tool_invocations",
            source_row_id="inv-1",
            payload=payload,
        )

    assert not any("INSERT INTO facts" in s for s in conn.sql_calls()), (
        f"Unexpected fact insertion in no-op path: {conn.sql_calls()}"
    )
    assert not any("'extracted_fact'" in s for s in conn.sql_calls())


@pytest.mark.asyncio
async def test_no_op_when_ok_false() -> None:
    """ok=false events are deferred to Phase 1 — no DB work at all."""
    conn = _FakeConn()
    projector = ToolResultExtractor(_settings())

    payload = {
        "tool_name": "mcp-xtb.compute_barrier",
        "user_entra_id": "u1",
        "project_id": None,
        "result_schema_id": "v1",
        "args": {},
        "result": None,
        "duration_ms": 100,
        "ok": False,
        "error": "SCF did not converge",
    }
    with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=conn)):
        await projector.handle(
            event_id="evt-2",
            event_type="tool_invocation_complete",
            source_table="tool_invocations",
            source_row_id="inv-2",
            payload=payload,
        )

    assert conn.calls == [], f"Expected no SQL on ok=false; got: {conn.calls}"


@pytest.mark.asyncio
async def test_no_op_when_tool_name_missing() -> None:
    """Malformed event (no tool_name) → no DB work."""
    conn = _FakeConn()
    projector = ToolResultExtractor(_settings())

    with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=conn)):
        await projector.handle(
            event_id="evt-3",
            event_type="tool_invocation_complete",
            source_table="tool_invocations",
            source_row_id="inv-3",
            payload={},  # no tool_name
        )

    assert conn.calls == []


@pytest.mark.asyncio
async def test_no_op_when_registry_row_disabled() -> None:
    """Registry hit but `enabled=false` → skip extractor entirely."""
    # registry SELECT → (extractor_module, enabled=False, promote_default=True)
    conn = _FakeConn(fetchone_queue=[("some.extractor", False, True)])
    projector = ToolResultExtractor(_settings())

    payload = {
        "tool_name": "mcp-xtb.compute_barrier",
        "user_entra_id": "u1",
        "project_id": None,
        "result_schema_id": "v1",
        "args": {},
        "result": {},
        "duration_ms": 0,
        "ok": True,
        "error": None,
    }
    with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=conn)):
        await projector.handle(
            event_id="evt-4",
            event_type="tool_invocation_complete",
            source_table="tool_invocations",
            source_row_id="inv-4",
            payload=payload,
        )

    assert not any("INSERT INTO facts" in s for s in conn.sql_calls())


@pytest.mark.asyncio
async def test_no_op_when_promote_default_false_and_no_explicit_flag() -> None:
    """Registry hit, enabled, but neither `promote_default` nor `args.promote_to_kg` → skip."""
    conn = _FakeConn(fetchone_queue=[("some.extractor", True, False)])
    projector = ToolResultExtractor(_settings())

    payload = {
        "tool_name": "mcp-xtb.compute_barrier",
        "user_entra_id": "u1",
        "project_id": None,
        "result_schema_id": "v1",
        "args": {},  # no promote_to_kg
        "result": {},
        "duration_ms": 0,
        "ok": True,
        "error": None,
    }
    with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=conn)):
        await projector.handle(
            event_id="evt-5",
            event_type="tool_invocation_complete",
            source_table="tool_invocations",
            source_row_id="inv-5",
            payload=payload,
        )

    assert not any("INSERT INTO facts" in s for s in conn.sql_calls())


def test_projector_metadata() -> None:
    """Pin the name (projection_acks key) and interested event types."""
    assert ToolResultExtractor.name == "tool_result_extractor"
    assert ToolResultExtractor.interested_event_types == ("tool_invocation_complete",)
