"""Unit tests for the wiki_linter daemon (ADR 012 Phase 4a).

Pure-Postgres sweeps — fake async conn (substring-keyed) covers the SELECTs;
we assert the SQL the linter issues (missing-page stub INSERTs, the orphan
SELECT, the index rebuild, the log append) and the `_render_index` markdown.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, patch

import psycopg
import pytest

from services.optimizer.wiki_linter.main import (
    Settings,
    _render_index,
    _rebuild_index,
    _sweep_missing_project_pages,
    _sweep_orphans,
    run_once,
)


# ---------------------------------------------------------------------------
# Fake async-Postgres (substring-keyed responder)
# ---------------------------------------------------------------------------


class _FakeCursor:
    def __init__(self, conn: "_FakeConn") -> None:
        self._conn = conn
        self._rows: list[dict[str, Any]] = []

    async def __aenter__(self) -> "_FakeCursor":
        return self

    async def __aexit__(self, *_a: Any) -> bool:
        return False

    async def execute(self, sql: str, params: Any = None) -> None:
        self._conn.calls.append((sql, params))
        self._rows = self._conn.lookup(sql)

    async def fetchone(self) -> dict[str, Any] | None:
        return self._rows[0] if self._rows else None

    async def fetchall(self) -> list[dict[str, Any]]:
        return list(self._rows)

    @property
    def rowcount(self) -> int:
        return self._conn.rowcount


class _FakeConn:
    def __init__(self, fetchers: list[tuple[str, list[dict[str, Any]]]], rowcount: int = 1) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.committed = 0
        self.rowcount = rowcount
        self._fetchers = fetchers

    async def __aenter__(self) -> "_FakeConn":
        return self

    async def __aexit__(self, *_a: Any) -> bool:
        return False

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self)

    async def commit(self) -> None:
        self.committed += 1

    async def rollback(self) -> None:
        self.committed += 1

    def lookup(self, sql: str) -> list[dict[str, Any]]:
        for substr, rows in self._fetchers:
            if substr in sql:
                return rows
        return []

    def sql_with(self, needle: str) -> list[tuple[str, Any]]:
        return [(s, p) for (s, p) in self.calls if needle in s]


def _settings() -> Settings:
    return Settings(_env_file=None, postgres_password="x")  # type: ignore[call-arg]


# ---------------------------------------------------------------------------
# _render_index
# ---------------------------------------------------------------------------


def test_render_index_groups_by_kind_in_order() -> None:
    rows = [
        {"slug": "topic/buchwald", "kind": "topic", "title": "Buchwald amination", "summary": "Pd C–N coupling.", "maturity": "WORKING", "source_count": 3, "dirty": False, "has_human_edits": True, "updated_at": "2026-05-12"},
        {"slug": "project/NCE-0042", "kind": "nce_project", "title": "Project Aurora", "summary": None, "maturity": "EXPLORATORY", "source_count": 0, "dirty": True, "has_human_edits": False, "updated_at": "2026-05-12"},
        {"slug": "compound/IK", "kind": "compound", "title": "Aspirin", "summary": "x" * 300, "maturity": "FOUNDATION", "source_count": 5, "dirty": False, "has_human_edits": False, "updated_at": "2026-05-10"},
    ]
    md = _render_index(rows)
    assert md.startswith("# Knowledge-wiki index")
    assert "3 current page(s)" in md
    # nce_project section comes before compound, which comes before topic.
    assert md.index("## nce_project") < md.index("## compound") < md.index("## topic")
    # Links use the article: form; flags surface dirty / human-edited.
    assert "[`project/NCE-0042`](article:project/NCE-0042)" in md
    assert "_(dirty)_" in md
    assert "_(human-edited)_" in md
    # Long summaries are truncated with an ellipsis.
    assert "…" in md


# ---------------------------------------------------------------------------
# _sweep_missing_project_pages
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sweep_missing_project_pages_creates_dirty_stubs() -> None:
    conn = _FakeConn([(
        "FROM nce_projects np",
        [
            {"project_id": "33333333-3333-3333-3333-333333333333", "internal_id": "NCE-0042", "name": "Project Aurora"},
            {"project_id": "44444444-4444-4444-4444-444444444444", "internal_id": "NCE-0099", "name": "Project Borealis"},
        ],
    )], rowcount=1)
    created = await _sweep_missing_project_pages(conn, 100)  # type: ignore[arg-type]
    assert created == 2
    ins = conn.sql_with("INSERT INTO knowledge_articles")
    assert len(ins) == 2
    # params: (internal_id, title, entity_ref_json, project_id, group_id, created_by)
    assert ins[0][1][0] == "NCE-0042" and ins[0][1][1] == "Project Aurora"
    assert json.loads(ins[0][1][2])["id_value"] == "NCE-0042"
    assert ins[0][1][3] == "33333333-3333-3333-3333-333333333333"
    assert "ON CONFLICT (slug) DO NOTHING" in ins[0][0]
    assert "'lint:missing_page'" in ins[0][0]
    assert conn.committed >= 1


@pytest.mark.asyncio
async def test_sweep_missing_project_pages_noop_when_all_have_pages() -> None:
    conn = _FakeConn([("FROM nce_projects np", [])])
    created = await _sweep_missing_project_pages(conn, 100)  # type: ignore[arg-type]
    assert created == 0
    assert conn.sql_with("INSERT INTO knowledge_articles") == []


# ---------------------------------------------------------------------------
# _sweep_orphans
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sweep_orphans_returns_unlinked_topic_pages() -> None:
    conn = _FakeConn([("FROM knowledge_articles ka", [{"slug": "topic/lonely"}, {"slug": "topic/also-lonely"}])])
    orphans = await _sweep_orphans(conn)  # type: ignore[arg-type]
    assert orphans == ["topic/lonely", "topic/also-lonely"]
    # The orphan SELECT joins against article-kind citations.
    sel = conn.sql_with("FROM knowledge_articles ka")[0][0]
    assert "c.cite_kind = 'article'" in sel and "ka.kind = 'topic'" in sel


# ---------------------------------------------------------------------------
# _rebuild_index
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rebuild_index_writes_when_changed() -> None:
    conn = _FakeConn([
        ("FROM knowledge_articles\n             WHERE status = 'current' AND slug NOT IN ('index', 'log')",
         [{"slug": "topic/x", "kind": "topic", "title": "X", "summary": None, "maturity": "EXPLORATORY", "source_count": 1, "dirty": False, "has_human_edits": False, "updated_at": "2026-05-12"}]),
        ("SELECT body_md FROM knowledge_articles WHERE slug = 'index'", [{"body_md": "STALE OLD INDEX"}]),
    ])
    changed = await _rebuild_index(conn)  # type: ignore[arg-type]
    assert changed is True
    ins = conn.sql_with("INSERT INTO knowledge_articles")
    assert len(ins) == 1
    assert "'index', 'index'" in ins[0][0] and "ON CONFLICT (slug) DO UPDATE" in ins[0][0]
    # The new body (param 0) contains the page entry.
    assert "topic/x" in ins[0][1][0]


@pytest.mark.asyncio
async def test_rebuild_index_noop_when_unchanged() -> None:
    rows = [{"slug": "topic/x", "kind": "topic", "title": "X", "summary": None, "maturity": "EXPLORATORY", "source_count": 1, "dirty": False, "has_human_edits": False, "updated_at": "2026-05-12"}]
    body = _render_index(rows)
    conn = _FakeConn([
        ("FROM knowledge_articles\n             WHERE status = 'current' AND slug NOT IN ('index', 'log')", rows),
        ("SELECT body_md FROM knowledge_articles WHERE slug = 'index'", [{"body_md": body}]),
    ])
    changed = await _rebuild_index(conn)  # type: ignore[arg-type]
    assert changed is False
    assert conn.sql_with("INSERT INTO knowledge_articles") == []


# ---------------------------------------------------------------------------
# run_once — end-to-end over a fake conn
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_once_collects_stats() -> None:
    conn = _FakeConn([
        ("FROM nce_projects np", [{"project_id": "33333333-3333-3333-3333-333333333333", "internal_id": "NCE-0042", "name": "Aurora"}]),
        ("FROM knowledge_articles ka", [{"slug": "topic/lonely"}]),  # orphans
        ("FROM knowledge_articles\n             WHERE status = 'current' AND slug NOT IN ('index', 'log')",
         [{"slug": "project/NCE-0042", "kind": "nce_project", "title": "Aurora", "summary": None, "maturity": "EXPLORATORY", "source_count": 0, "dirty": True, "has_human_edits": False, "updated_at": "2026-05-12"}]),
        ("SELECT body_md FROM knowledge_articles WHERE slug = 'index'", []),  # no index yet → write
    ], rowcount=1)
    with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=conn)):
        stats = await run_once(_settings())
    assert stats["stubs_created"] == 1
    assert stats["orphans"] == 1
    assert stats["index_rebuilt"] is True
    assert stats["errors"] == 0
    # A `log` page entry was appended.
    assert any("'log', 'log'" in s and "ON CONFLICT (slug) DO UPDATE" in s for (s, _p) in conn.calls)
