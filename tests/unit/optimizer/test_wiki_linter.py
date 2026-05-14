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
    _contradiction_slug,
    _render_index,
    _rebuild_index,
    _slugify,
    _sweep_contradictions,
    _sweep_missing_project_pages,
    _sweep_orphans,
    _sweep_stale_citations,
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


# ---------------------------------------------------------------------------
# Phase 4b-ii: _slugify / _contradiction_slug
# ---------------------------------------------------------------------------


def test_slugify_lowercases_and_replaces_unsafe_chars() -> None:
    assert _slugify("Compound XYZ-123") == "compound-xyz-123"
    assert _slugify("Buchwald & Hartwig") == "buchwald-hartwig"
    # Collapses runs of separators, trims edges.
    assert _slugify("---foo!!!bar---") == "foo-bar"


def test_contradiction_slug_is_stable_and_safe() -> None:
    a = _contradiction_slug("Compound", "RYY-VLZ-VUVIJVGH", "HAS_PROPERTY")
    b = _contradiction_slug("Compound", "RYY-VLZ-VUVIJVGH", "HAS_PROPERTY")
    assert a == b  # determinism
    assert a.startswith("contradiction/")
    # No empty segments, no // collapses, fits the DB length cap (256).
    assert "//" not in a
    assert not a.endswith("/")
    assert len(a) <= 256


# ---------------------------------------------------------------------------
# Phase 4b-ii: _sweep_stale_citations (Neo4j-backed)
# ---------------------------------------------------------------------------


class _FakeNeo4jResult:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows

    def __aiter__(self) -> "_FakeNeo4jResult":
        self._i = 0
        return self

    async def __anext__(self) -> dict[str, Any]:
        if self._i >= len(self._rows):
            raise StopAsyncIteration
        row = self._rows[self._i]
        self._i += 1
        return row


class _FakeNeo4jSession:
    def __init__(self, parent: "_FakeNeo4jClient") -> None:
        self._parent = parent

    async def __aenter__(self) -> "_FakeNeo4jSession":
        return self

    async def __aexit__(self, *_a: Any) -> bool:
        return False

    async def run(self, cypher: str, **params: Any) -> _FakeNeo4jResult:
        self._parent.runs.append((cypher, params))
        # Substring-keyed responder.
        for needle, rows in self._parent.responders:
            if needle in cypher:
                return _FakeNeo4jResult(rows)
        return _FakeNeo4jResult([])


class _FakeNeo4jClient:
    def __init__(self, responders: list[tuple[str, list[dict[str, Any]]]]) -> None:
        self.runs: list[tuple[str, dict[str, Any]]] = []
        self.responders = responders
        self.closed = False

    def session(self) -> _FakeNeo4jSession:
        # _sweep_* call `async with client.session() as sess:`; need an async CM.
        return _FakeNeo4jSession(self)

    async def close(self) -> None:
        self.closed = True


@pytest.mark.asyncio
async def test_sweep_stale_citations_marks_pages_dirty() -> None:
    fact_a = "11111111-1111-1111-1111-111111111111"
    fact_b = "22222222-2222-2222-2222-222222222222"  # never invalidated
    conn = _FakeConn([(
        "FROM knowledge_article_citations c",
        [
            {"article_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "slug": "compound/abc", "fact_id": fact_a},
            {"article_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "slug": "topic/clean", "fact_id": fact_b},
        ],
    )], rowcount=1)
    neo = _FakeNeo4jClient([("MATCH (f:Fact {fact_id: fid})", [{"fact_id": fact_a}])])
    redirtied = await _sweep_stale_citations(conn, neo, limit=100)  # type: ignore[arg-type]
    assert redirtied == 1
    # The UPDATE only fires for the article that cites the invalidated fact.
    updates = conn.sql_with("UPDATE knowledge_articles")
    assert len(updates) == 1
    assert "'lint:stale_citation'" in updates[0][0]
    assert updates[0][1] == ("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",)


@pytest.mark.asyncio
async def test_sweep_stale_citations_no_facts_short_circuits() -> None:
    conn = _FakeConn([("FROM knowledge_article_citations c", [])])
    neo = _FakeNeo4jClient([])
    redirtied = await _sweep_stale_citations(conn, neo, limit=100)  # type: ignore[arg-type]
    assert redirtied == 0
    assert neo.runs == []  # never even talks to Neo4j


# ---------------------------------------------------------------------------
# Phase 4b-ii: _sweep_contradictions (Neo4j-backed)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sweep_contradictions_creates_stub() -> None:
    conn = _FakeConn([], rowcount=1)
    neo = _FakeNeo4jClient([(
        "MATCH (f:Fact)",
        [{
            "subject_label": "Compound",
            "subject_id_value": "RYYVLZVUVIJVGH",
            "predicate": "HAS_YIELD",
            "objects": ["0.62", "0.74"],
            "fact_ids": [
                "11111111-1111-1111-1111-111111111111",
                "22222222-2222-2222-2222-222222222222",
            ],
        }],
    )])
    created = await _sweep_contradictions(conn, neo, min_objects=2, limit=10)  # type: ignore[arg-type]
    assert created == 1
    ins = conn.sql_with("INSERT INTO knowledge_articles")
    assert len(ins) == 1
    # Slug + kind + dirty_reason as expected.
    params = ins[0][1]
    # `_` is slug-safe (per the DB convention) so HAS_YIELD lowercases to has_yield.
    assert params[0].startswith("contradiction/compound/ryyvlzvuvijvgh/has_yield")
    er = json.loads(params[2])
    assert er["subject_label"] == "Compound"
    assert er["predicate"] == "HAS_YIELD"
    assert len(er["fact_ids"]) == 2
    assert "'lint:contradiction'" in ins[0][0]


@pytest.mark.asyncio
async def test_sweep_contradictions_respects_limit_and_min() -> None:
    conn = _FakeConn([], rowcount=1)
    # Return 5 groups; cap to 2 via limit.
    rows = [
        {
            "subject_label": "Compound", "subject_id_value": f"S{i}",
            "predicate": "HAS_X", "objects": ["a", "b"],
            "fact_ids": [f"00000000-0000-0000-0000-00000000000{i}", f"11111111-1111-1111-1111-11111111111{i}"],
        }
        for i in range(5)
    ]
    neo = _FakeNeo4jClient([("MATCH (f:Fact)", rows)])
    created = await _sweep_contradictions(conn, neo, min_objects=2, limit=2)  # type: ignore[arg-type]
    assert created == 2
