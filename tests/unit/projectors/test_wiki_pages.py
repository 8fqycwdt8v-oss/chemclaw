"""Unit tests for the wiki_pages projector (ADR 012 Phase 2a).

The projector keeps knowledge_articles in sync with "which pages exist /
need (re)synthesis". Without spinning up Postgres we assert the SQL it issues
per event type: stub creation (INSERT ... ON CONFLICT DO UPDATE), project /
campaign / document slugs, the fact_invalidated → citing-page UPDATE, and
that a replay issues the identical idempotent statement.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, patch

import psycopg
import pytest

from services.projectors.common.base import PermanentHandlerError, ProjectorSettings
from services.projectors.wiki_pages.main import WikiPagesProjector


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
        self._conn._last_select_sql = sql if sql.lstrip().upper().startswith("SELECT") else self._conn._last_select_sql

    async def fetchone(self) -> dict[str, Any] | None:
        return self._conn.lookup(self._conn._last_select_sql)

    @property
    def rowcount(self) -> int:
        return self._conn.rowcount


class _FakeConn:
    def __init__(self, fetchers: list[tuple[str, dict[str, Any] | None]], rowcount: int = 1) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.committed = 0
        self.rowcount = rowcount
        self._fetchers = fetchers
        self._last_select_sql = ""

    async def __aenter__(self) -> "_FakeConn":
        return self

    async def __aexit__(self, *_a: Any) -> bool:
        return False

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self)

    async def commit(self) -> None:
        self.committed += 1

    def lookup(self, sql: str) -> dict[str, Any] | None:
        for substr, resp in self._fetchers:
            if substr in sql:
                return resp
        return None

    # Assertions helpers ---------------------------------------------------
    def inserts(self) -> list[tuple[str, Any]]:
        return [(s, p) for (s, p) in self.calls if "INSERT INTO knowledge_articles" in s]

    def updates(self) -> list[tuple[str, Any]]:
        return [(s, p) for (s, p) in self.calls if "UPDATE knowledge_articles" in s and "INSERT" not in s]


def _settings() -> ProjectorSettings:
    return ProjectorSettings(_env_file=None, postgres_password="x")  # type: ignore[call-arg]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_metadata() -> None:
    assert WikiPagesProjector.name == "wiki_pages"
    for et in (
        "document_ingested",
        "experiment_imported",
        "hypothesis_proposed",
        "hypothesis_status_changed",
        "synthesis_campaign_created",
        "synthesis_campaign_state_changed",
        "fact_invalidated",
    ):
        assert et in WikiPagesProjector.interested_event_types


@pytest.mark.asyncio
async def test_document_ingested_creates_stub() -> None:
    sha = "ABCDEF0123456789DEADBEEFCAFEBABE"
    conn = _FakeConn([("FROM documents", {"sha256": sha, "title": "Synthetic SOP-042"})])
    proj = WikiPagesProjector(_settings())
    with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=conn)):
        await proj.handle(
            event_id="e1", event_type="document_ingested",
            source_table="documents", source_row_id="11111111-1111-1111-1111-111111111111",
            payload={},
        )
    assert conn.committed == 1
    ins = conn.inserts()
    assert len(ins) == 1
    sql, params = ins[0]
    assert "ON CONFLICT (slug) DO UPDATE" in sql
    assert "dirty        = true" in sql or "dirty = true" in sql
    assert params[0] == f"document/{sha[:16]}"          # slug
    assert params[1] == "document_digest"               # kind
    assert params[2] == "Synthetic SOP-042"             # title
    # entity_ref carries the sha256.
    assert json.loads(params[3])["id_value"] == sha
    assert params[6] == "document_ingested"             # dirty_reason
    assert params[7] == "__system__"                    # created_by


@pytest.mark.asyncio
async def test_document_missing_raises_permanent() -> None:
    conn = _FakeConn([("FROM documents", None)])
    proj = WikiPagesProjector(_settings())
    with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=conn)):
        with pytest.raises(PermanentHandlerError):
            await proj.handle(
                event_id="e1", event_type="document_ingested",
                source_table="documents", source_row_id="11111111-1111-1111-1111-111111111111",
                payload={},
            )
    assert conn.inserts() == []


@pytest.mark.asyncio
async def test_synthesis_campaign_touches_campaign_and_project_pages() -> None:
    cid = "22222222-2222-2222-2222-222222222222"
    conn = _FakeConn([(
        "FROM synthesis_campaigns sc",
        {
            "campaign_id": cid, "campaign_name": "Buchwald route opt", "kind": "bo_campaign",
            "project_id": "33333333-3333-3333-3333-333333333333",
            "internal_id": "NCE-0042", "project_name": "Project Aurora",
        },
    )])
    proj = WikiPagesProjector(_settings())
    with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=conn)):
        await proj.handle(
            event_id="e2", event_type="synthesis_campaign_created",
            source_table="synthesis_campaigns", source_row_id=cid, payload={},
        )
    slugs = sorted(p[0] for (_s, p) in conn.inserts())
    assert slugs == [f"campaign/{cid}", "project/NCE-0042"]
    # The campaign page's nce_project_id (param index 4) is set.
    camp_ins = next(p for (_s, p) in conn.inserts() if p[0] == f"campaign/{cid}")
    assert camp_ins[4] == "33333333-3333-3333-3333-333333333333"  # nce_project_id


@pytest.mark.asyncio
async def test_hypothesis_scoped_touches_project_page() -> None:
    conn = _FakeConn([("FROM hypotheses h", {
        "project_id": "33333333-3333-3333-3333-333333333333",
        "internal_id": "NCE-0042", "name": "Project Aurora",
    })])
    proj = WikiPagesProjector(_settings())
    with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=conn)):
        await proj.handle(
            event_id="e3", event_type="hypothesis_proposed",
            source_table="hypotheses", source_row_id="44444444-4444-4444-4444-444444444444",
            payload={},
        )
    ins = conn.inserts()
    assert len(ins) == 1
    assert ins[0][1][0] == "project/NCE-0042"
    assert ins[0][1][6] == "hypothesis_proposed"  # dirty_reason


@pytest.mark.asyncio
async def test_hypothesis_unscoped_is_noop() -> None:
    conn = _FakeConn([("FROM hypotheses h", None)])  # no project join → unscoped
    proj = WikiPagesProjector(_settings())
    with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=conn)):
        await proj.handle(
            event_id="e4", event_type="hypothesis_status_changed",
            source_table="hypotheses", source_row_id="44444444-4444-4444-4444-444444444444",
            payload={},
        )
    assert conn.inserts() == []
    assert conn.committed == 1  # still commits (empty txn)


@pytest.mark.asyncio
async def test_fact_invalidated_marks_citing_pages_dirty() -> None:
    fid = "55555555-5555-5555-5555-555555555555"
    conn = _FakeConn([], rowcount=3)
    proj = WikiPagesProjector(_settings())
    with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=conn)):
        await proj.handle(
            event_id="e5", event_type="fact_invalidated",
            source_table="hypotheses", source_row_id="44444444-4444-4444-4444-444444444444",
            payload={"fact_id": fid, "edge_fact_id": "x", "invalidated_by": "hypothesis_refuted"},
        )
    ups = conn.updates()
    assert len(ups) == 1
    sql, params = ups[0]
    assert "knowledge_article_citations" in sql
    assert "cite_kind = 'fact'" in sql
    assert fid in params  # cite_ref param
    assert any("stale_citation" in str(p) for p in params)  # dirty_reason


@pytest.mark.asyncio
async def test_fact_invalidated_without_fact_id_is_noop() -> None:
    conn = _FakeConn([])
    proj = WikiPagesProjector(_settings())
    with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=conn)):
        await proj.handle(
            event_id="e6", event_type="fact_invalidated",
            source_table="hypotheses", source_row_id="44444444-4444-4444-4444-444444444444",
            payload={"edge_fact_id": "x"},
        )
    assert conn.updates() == []


@pytest.mark.asyncio
async def test_replay_issues_identical_idempotent_statement() -> None:
    sha = "ABCDEF0123456789DEADBEEFCAFEBABE"

    async def run_once() -> tuple[str, Any]:
        conn = _FakeConn([("FROM documents", {"sha256": sha, "title": "SOP"})])
        proj = WikiPagesProjector(_settings())
        with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=conn)):
            await proj.handle(
                event_id="e", event_type="document_ingested",
                source_table="documents", source_row_id="11111111-1111-1111-1111-111111111111",
                payload={},
            )
        return conn.inserts()[0]

    first = await run_once()
    second = await run_once()
    assert first[0] == second[0]  # identical SQL
    assert first[1] == second[1]  # identical params
    assert "ON CONFLICT (slug) DO UPDATE" in first[0]
