"""Unit tests for the wiki_kg projector (ADR 012 Phase 3a).

Asserts the Cypher it issues — :WikiPage MERGE, :SUMMARIZES to an existing
entity node, :GROUNDS to existing :Fact nodes, the dropped-facts close, the
archive path — and the deterministic edge-id. No real Neo4j or Postgres
(fake session captures run() calls; fake async conn answers the title +
citation reads). Mirrors test_kg_hypotheses_idempotency.py / test_wiki_pages.py.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, patch

import psycopg
import pytest

from services.projectors.common.base import ProjectorSettings
import services.projectors.wiki_kg.main as wm
from services.projectors.wiki_kg.main import WikiKgProjector, _deterministic_edge_id, _safe_group_id


# ---------------------------------------------------------------------------
# Fake Neo4j
# ---------------------------------------------------------------------------


class _FakeSession:
    def __init__(self) -> None:
        self.runs: list[tuple[str, dict[str, Any]]] = []

    async def __aenter__(self) -> "_FakeSession":
        return self

    async def __aexit__(self, *_a: Any) -> bool:
        return False

    async def run(self, cypher: str, **params: Any) -> None:
        self.runs.append((cypher, params))


class _FakeNeo4j:
    def __init__(self) -> None:
        self.sess = _FakeSession()

    @classmethod
    def from_env(cls) -> "_FakeNeo4j":
        return cls()

    def session(self, **_kw: Any) -> _FakeSession:
        return self.sess

    async def close(self) -> None:
        pass


# ---------------------------------------------------------------------------
# Fake async Postgres (substring-keyed)
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


class _FakeConn:
    def __init__(self, fetchers: list[tuple[str, list[dict[str, Any]]]]) -> None:
        self.calls: list[tuple[str, Any]] = []
        self._fetchers = fetchers

    async def __aenter__(self) -> "_FakeConn":
        return self

    async def __aexit__(self, *_a: Any) -> bool:
        return False

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self)

    def lookup(self, sql: str) -> list[dict[str, Any]]:
        for substr, rows in self._fetchers:
            if substr in sql:
                return rows
        return []


def _settings() -> ProjectorSettings:
    return ProjectorSettings(_env_file=None, postgres_password="x")  # type: ignore[call-arg]


async def _run_handle(pg: _FakeConn, **handle_kwargs: Any) -> _FakeSession:
    with patch.object(wm, "Neo4jClient", _FakeNeo4j):
        proj = WikiKgProjector(_settings())
    fake_sess = proj._neo4j.sess  # type: ignore[attr-defined]
    with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=pg)):
        await proj.handle(**handle_kwargs)
    return fake_sess


def _runs_with(sess: _FakeSession, needle: str) -> list[tuple[str, dict[str, Any]]]:
    return [(c, p) for (c, p) in sess.runs if needle in c]


ART_ID = "11111111-1111-1111-1111-111111111111"
FACT_A = "22222222-2222-2222-2222-222222222222"
FACT_B = "33333333-3333-3333-3333-333333333333"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_metadata_and_helpers() -> None:
    assert WikiKgProjector.name == "wiki_kg"
    assert "knowledge_article_created" in WikiKgProjector.interested_event_types
    assert "knowledge_article_revised" in WikiKgProjector.interested_event_types
    assert "knowledge_article_archived" in WikiKgProjector.interested_event_types
    # Deterministic edge id.
    a = _deterministic_edge_id("project/NCE-0042", FACT_A)
    b = _deterministic_edge_id("project/NCE-0042", FACT_A)
    assert a == b
    uuid.UUID(a)  # parses
    assert a != _deterministic_edge_id("project/NCE-0042", FACT_B)
    # group_id guard.
    assert _safe_group_id(None) == "__system__"
    assert _safe_group_id("33333333-3333-3333-3333-333333333333") == "33333333-3333-3333-3333-333333333333"
    with pytest.raises(ValueError):
        _safe_group_id("bad id with spaces and ; semicolons")


@pytest.mark.asyncio
async def test_created_merges_wikipage_summarizes_and_grounds() -> None:
    pg = _FakeConn([
        ("FROM knowledge_articles WHERE id", [{"title": "Project Aurora", "kind": "nce_project"}]),
        ("FROM knowledge_article_citations", [{"cite_ref": FACT_A}, {"cite_ref": FACT_B}]),
    ])
    sess = await _run_handle(
        pg,
        event_id="e1", event_type="knowledge_article_created",
        source_table="knowledge_articles", source_row_id=ART_ID,
        payload={
            "article_id": ART_ID, "slug": "project/NCE-0042", "kind": "nce_project",
            "revision": 1, "group_id": "__system__",
            "entity_ref": {"label": "NCEProject", "id_property": "internal_id", "id_value": "NCE-0042"},
        },
    )
    # :WikiPage MERGE.
    wp = _runs_with(sess, "MERGE (wp:WikiPage {slug: $slug})")
    assert wp and wp[0][1]["slug"] == "project/NCE-0042" and wp[0][1]["revision"] == 1 and wp[0][1]["title"] == "Project Aurora"
    # :SUMMARIZES to an existing :NCEProject node.
    summ = _runs_with(sess, ":SUMMARIZES")
    assert summ and "NCEProject {internal_id: $idv}" in summ[0][0] and summ[0][1]["idv"] == "NCE-0042"
    # :GROUNDS — one run per fact, each with a deterministic edge_id.
    grounds = _runs_with(sess, "MERGE (wp)-[g:GROUNDS")
    assert {p["fid"] for (_c, p) in grounds} == {FACT_A, FACT_B}
    assert all(p["edge_id"] == _deterministic_edge_id("project/NCE-0042", p["fid"]) for (_c, p) in grounds)
    assert all(p["revision"] == 1 for (_c, p) in grounds)
    # The dropped-facts close runs too (no-op at rev 1, but always issued).
    assert _runs_with(sess, "dropped_from_revision")


@pytest.mark.asyncio
async def test_revised_with_fewer_facts_still_closes_dropped() -> None:
    pg = _FakeConn([
        ("FROM knowledge_articles WHERE id", [{"title": "Aurora", "kind": "nce_project"}]),
        ("FROM knowledge_article_citations", [{"cite_ref": FACT_A}]),  # FACT_B dropped at rev 3
    ])
    sess = await _run_handle(
        pg,
        event_id="e2", event_type="knowledge_article_revised",
        source_table="knowledge_articles", source_row_id=ART_ID,
        payload={"article_id": ART_ID, "slug": "project/NCE-0042", "kind": "nce_project", "revision": 3, "group_id": "__system__", "entity_ref": None},
    )
    grounds = _runs_with(sess, "MERGE (wp)-[g:GROUNDS")
    assert {p["fid"] for (_c, p) in grounds} == {FACT_A}
    close = _runs_with(sess, "dropped_from_revision")
    assert close and close[0][1]["revision"] == 3
    # No :SUMMARIZES when entity_ref is None.
    assert not _runs_with(sess, ":SUMMARIZES")


@pytest.mark.asyncio
async def test_summarizes_skips_unmapped_labels() -> None:
    pg = _FakeConn([
        ("FROM knowledge_articles WHERE id", [{"title": "Campaign X", "kind": "synthesis_campaign"}]),
        ("FROM knowledge_article_citations", []),
    ])
    sess = await _run_handle(
        pg,
        event_id="e3", event_type="knowledge_article_created",
        source_table="knowledge_articles", source_row_id=ART_ID,
        payload={"article_id": ART_ID, "slug": "campaign/abc", "kind": "synthesis_campaign", "revision": 1, "group_id": "__system__",
                 "entity_ref": {"label": "SynthesisCampaign", "id_property": "id", "id_value": "abc"}},
    )
    assert _runs_with(sess, "MERGE (wp:WikiPage {slug: $slug})")  # page still merged
    assert not _runs_with(sess, ":SUMMARIZES")  # SynthesisCampaign isn't a mapped target


@pytest.mark.asyncio
async def test_archived_sets_flag_and_closes_grounds_without_pg_read() -> None:
    pg = _FakeConn([])  # should not be queried
    sess = await _run_handle(
        pg,
        event_id="e4", event_type="knowledge_article_archived",
        source_table="knowledge_articles", source_row_id=ART_ID,
        payload={"article_id": ART_ID, "slug": "project/NCE-0042", "kind": "nce_project", "group_id": "__system__"},
    )
    archived = _runs_with(sess, "SET wp.archived = true")
    assert archived and "page_archived" in archived[0][0]
    assert pg.calls == []  # no Postgres read on the archive path


@pytest.mark.asyncio
async def test_missing_slug_is_noop() -> None:
    pg = _FakeConn([])
    sess = await _run_handle(
        pg,
        event_id="e5", event_type="knowledge_article_created",
        source_table="knowledge_articles", source_row_id=None, payload={},
    )
    assert sess.runs == []
    assert pg.calls == []


@pytest.mark.asyncio
async def test_article_row_gone_is_noop() -> None:
    pg = _FakeConn([("FROM knowledge_articles WHERE id", [])])  # row deleted
    sess = await _run_handle(
        pg,
        event_id="e6", event_type="knowledge_article_revised",
        source_table="knowledge_articles", source_row_id=ART_ID,
        payload={"article_id": ART_ID, "slug": "project/X", "kind": "nce_project", "revision": 2, "group_id": "__system__"},
    )
    assert sess.runs == []  # nothing written to Neo4j when the page row is gone
