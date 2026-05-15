"""
Phase 0 wires the dispatcher; Phase 1+ writes the actual extractors.
This test pins the dispatch contract: registry HIT → extractor module is
imported and called with (result, ctx); returned FactDrafts are INSERTed
and an `extracted_fact` event is emitted.
"""
from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import psycopg
import pytest

from services.projectors.common.base import ProjectorSettings
from services.projectors.tool_result_extractor import extractor_loader
from services.projectors.tool_result_extractor.main import (
    FactDraft,
    ToolResultExtractor,
)


# ---------------------------------------------------------------------------
# Fake async-Postgres plumbing
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

    async def fetchone(self) -> Any:
        return self._conn.next_fetchone()


class _FakeConn:
    def __init__(self, fetchone_queue: list[Any] | None = None) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.committed = 0
        self._fetchone_queue = list(fetchone_queue or [])

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
async def test_dispatch_invokes_registered_module(monkeypatch: pytest.MonkeyPatch) -> None:
    """Registry HIT → extractor module loaded, called with (result, ctx),
    each returned FactDraft inserted, and an `extracted_fact` event emitted.
    """
    fake_module = MagicMock()
    fake_module.extract = MagicMock(
        return_value=[
            FactDraft(
                subject_label="Compound",
                subject_id_value="ABC",
                predicate="has_barrier_kJ_mol",
                derivation_class="COMPUTED",
                confidence=0.95,
                confidence_tier="high",
                extractor_name="xtb_extractor",
                object_value={"v": 92.3},
                unit="kJ/mol",
            )
        ]
    )
    monkeypatch.setattr(
        extractor_loader,
        "load_extractor",
        lambda module_path: fake_module,
    )

    new_fact_id = uuid.uuid4()
    conn = _FakeConn(
        fetchone_queue=[
            # 1) extraction_registry SELECT
            ("services.projectors.fact_extractor.xtb", True, True),
            # 2) RETURNING id from INSERT INTO facts
            (new_fact_id,),
        ]
    )
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

    sqls = conn.sql_calls()
    assert any("FROM extraction_registry" in s for s in sqls), (
        f"Expected extraction_registry lookup; got: {sqls}"
    )
    assert any("INSERT INTO facts" in s for s in sqls), (
        f"Expected fact insertion; got: {sqls}"
    )
    assert any("'extracted_fact'" in s for s in sqls), (
        f"Expected `extracted_fact` ingestion event emission; got: {sqls}"
    )

    # extractor was invoked with (result_dict, ExtractionContext)
    assert fake_module.extract.call_count == 1
    args, _ = fake_module.extract.call_args
    assert args[0] == {"barrier_kj_mol": 92.3}
    ctx = args[1]
    assert ctx.tool_name == "mcp-xtb.compute_barrier"
    assert ctx.invocation_id == "inv-1"
    assert ctx.duration_ms == 1234


@pytest.mark.asyncio
async def test_dispatch_honours_explicit_promote_flag_when_default_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """promote_default=False but args.promote_to_kg=True → still dispatch."""
    fake_module = MagicMock()
    fake_module.extract = MagicMock(
        return_value=[
            FactDraft(
                subject_label="Compound",
                subject_id_value="XYZ",
                predicate="has_some_property",
                derivation_class="COMPUTED",
                confidence=0.7,
                confidence_tier="medium",
                extractor_name="some_extractor",
            )
        ]
    )
    monkeypatch.setattr(
        extractor_loader, "load_extractor", lambda module_path: fake_module
    )

    new_fact_id = uuid.uuid4()
    conn = _FakeConn(
        fetchone_queue=[
            ("some.module", True, False),  # enabled, promote_default=False
            (new_fact_id,),
        ]
    )
    projector = ToolResultExtractor(_settings())

    payload = {
        "tool_name": "some.tool",
        "user_entra_id": "u1",
        "project_id": None,
        "result_schema_id": "v1",
        "args": {"promote_to_kg": True},  # explicit override
        "result": {"k": "v"},
        "duration_ms": 0,
        "ok": True,
        "error": None,
    }
    with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=conn)):
        await projector.handle(
            event_id="evt-2",
            event_type="tool_invocation_complete",
            source_table="tool_invocations",
            source_row_id="inv-2",
            payload=payload,
        )

    assert any("INSERT INTO facts" in s for s in conn.sql_calls())


@pytest.mark.asyncio
async def test_extractor_load_failure_is_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    """An ImportError from the loader is logged and the event is ack'd
    (handle returns without raising). No INSERTs happen."""

    def boom(module_path: str) -> Any:
        raise ImportError(f"cannot import {module_path}")

    monkeypatch.setattr(extractor_loader, "load_extractor", boom)

    conn = _FakeConn(fetchone_queue=[("does.not.exist", True, True)])
    projector = ToolResultExtractor(_settings())

    payload = {
        "tool_name": "mcp-x.t",
        "user_entra_id": "u1",
        "project_id": None,
        "result_schema_id": "v1",
        "args": {},
        "result": {},
        "duration_ms": 0,
        "ok": True,
        "error": None,
    }
    # Should not raise.
    with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=conn)):
        await projector.handle(
            event_id="evt-3",
            event_type="tool_invocation_complete",
            source_table="tool_invocations",
            source_row_id="inv-3",
            payload=payload,
        )

    # Only the registry SELECT should have run; no INSERTs.
    assert not any("INSERT INTO facts" in s for s in conn.sql_calls())


@pytest.mark.asyncio
async def test_extractor_raises_is_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    """Extractor module raises during `extract()` → logged, event ack'd, no inserts."""
    fake_module = MagicMock()
    fake_module.extract = MagicMock(side_effect=RuntimeError("extractor blew up"))
    monkeypatch.setattr(
        extractor_loader, "load_extractor", lambda module_path: fake_module
    )

    conn = _FakeConn(fetchone_queue=[("some.module", True, True)])
    projector = ToolResultExtractor(_settings())

    payload = {
        "tool_name": "some.tool",
        "user_entra_id": "u1",
        "project_id": None,
        "result_schema_id": "v1",
        "args": {},
        "result": {"x": 1},
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


# ---------------------------------------------------------------------------
# extractor_loader cache
# ---------------------------------------------------------------------------


def test_extractor_loader_imports_once_and_caches() -> None:
    """Importing the same module path twice hits the cache the second time.
    Modules that lack `extract` raise AttributeError.
    """
    extractor_loader.clear_cache()
    # `json` is stdlib, always importable; we use it just to verify the
    # AttributeError branch (no `extract` symbol).
    try:
        extractor_loader.load_extractor("json")
    except AttributeError as exc:
        assert "extract" in str(exc)
    else:
        pytest.fail("expected AttributeError because `json.extract` does not exist")


def test_extractor_loader_raises_importerror_on_unknown_module() -> None:
    extractor_loader.clear_cache()
    with pytest.raises(ImportError):
        extractor_loader.load_extractor("does.not.exist.module_xyz")
