"""Unit tests for the wiki_search_index projector (ADR 012 Phase 3b).

Covers the heading-aware chunker and the handle() write path (fake async conn
+ stubbed mcp-embedder httpx client): DELETE-then-INSERT on a revision, archive
→ DELETE, stub (empty body) → no-op, embedder 4xx → leave old chunks, archived
status → DELETE.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import psycopg
import pytest

from services.projectors.wiki_search_index.main import (
    Settings,
    WikiSearchIndexProjector,
    _chunk_markdown,
)


# ---------------------------------------------------------------------------
# Chunker
# ---------------------------------------------------------------------------


def test_chunk_markdown_tracks_heading_path() -> None:
    body = (
        "Intro line before any heading.\n"
        "# Identity\n\nInChIKey ABC. Formula C9H8O4.\n"
        "## Properties\n\nMW 180.16.\n"
        "# Where it appears\n\nSeen in [reaction:r1].\n"
    )
    chunks = _chunk_markdown(body)
    paths = [hp for hp, _t in chunks]
    assert paths == [None, "Identity", "Identity > Properties", "Where it appears"]
    # Heading line stays at the top of its section's chunk.
    assert chunks[1][1].startswith("# Identity")
    assert "InChIKey ABC" in chunks[1][1]
    assert "[reaction:r1]" in chunks[3][1]


def test_chunk_markdown_mid_section_flush() -> None:
    # A long section of normal paragraphs: the line-buffer flushes mid-section
    # once it exceeds target. (A single >target-length line stays one chunk —
    # acceptable: BGE-M3 handles it; LLM-generated pages have paragraph breaks.)
    paras = "\n\n".join("Paragraph text here. " * 25 for _ in range(8))  # ~8 × ~525 chars
    chunks = _chunk_markdown(f"# Big section\n\n{paras}\n", target_chars=500)
    assert len(chunks) >= 2  # split into multiple chunks
    assert all(hp == "Big section" for hp, _t in chunks)


def test_chunk_markdown_empty_body() -> None:
    assert _chunk_markdown("") == []
    assert _chunk_markdown("   \n\n  ") == []


# ---------------------------------------------------------------------------
# Fake async-Postgres + stubbed embedder
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

    def lookup(self, sql: str) -> list[dict[str, Any]]:
        for substr, rows in self._fetchers:
            if substr in sql:
                return rows
        return []

    def sql_with(self, needle: str) -> list[tuple[str, Any]]:
        return [(s, p) for (s, p) in self.calls if needle in s]


def _embed_resp(status: int, vectors: list[list[float]] | None = None) -> MagicMock:
    r = MagicMock()
    r.status_code = status
    r.text = "err"
    r.json.return_value = {"vectors": vectors or [], "dim": 1024}
    r.raise_for_status = MagicMock()
    return r


def _settings() -> Settings:
    return Settings(_env_file=None, postgres_password="x")  # type: ignore[call-arg]


ART = "11111111-1111-1111-1111-111111111111"


async def _run(pg: _FakeConn, embed_resp: MagicMock | None, **handle_kwargs: Any) -> WikiSearchIndexProjector:
    proj = WikiSearchIndexProjector(_settings())
    proj._client = AsyncMock()  # type: ignore[assignment]
    if embed_resp is not None:
        proj._client.post = AsyncMock(return_value=embed_resp)  # type: ignore[attr-defined]
    with patch.object(psycopg.AsyncConnection, "connect", AsyncMock(return_value=pg)):
        await proj.handle(**handle_kwargs)
    return proj


# ---------------------------------------------------------------------------
# handle()
# ---------------------------------------------------------------------------


def test_metadata() -> None:
    assert WikiSearchIndexProjector.name == "wiki_search_index"
    for et in ("knowledge_article_created", "knowledge_article_revised", "knowledge_article_archived"):
        assert et in WikiSearchIndexProjector.interested_event_types


@pytest.mark.asyncio
async def test_revised_deletes_then_inserts_chunks() -> None:
    body = "# Aurora\n\nA Pd-catalysed step [experiment:ELN-1].\n\n## Step 2\n\nReductive amination.\n"
    pg = _FakeConn([("FROM knowledge_articles WHERE id", [{"slug": "project/NCE-0042", "revision": 3, "body_md": body, "status": "current"}])])
    proj = await _run(
        pg, _embed_resp(200, [[0.1, 0.2], [0.3, 0.4]]),
        event_id="e1", event_type="knowledge_article_revised",
        source_table="knowledge_articles", source_row_id=ART,
        payload={"article_id": ART, "slug": "project/NCE-0042", "revision": 3},
    )
    # One DELETE then one INSERT per chunk.
    assert len(pg.sql_with("DELETE FROM wiki_chunks WHERE article_id")) == 1
    ins = pg.sql_with("INSERT INTO wiki_chunks")
    assert len(ins) == 2
    # params: (article_id, slug, revision, chunk_index, heading_path, text, embedding-literal, token_count)
    assert ins[0][1][0] == ART and ins[0][1][1] == "project/NCE-0042" and ins[0][1][2] == 3 and ins[0][1][3] == 0
    assert ins[1][1][3] == 1 and ins[1][1][4] == "Aurora > Step 2"
    assert ins[0][1][6] == "[0.10000000,0.20000000]"  # vector literal
    # Embedder called with the chunk texts.
    proj._client.post.assert_awaited()  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_stub_empty_body_is_noop_no_embed() -> None:
    pg = _FakeConn([("FROM knowledge_articles WHERE id", [{"slug": "project/X", "revision": 1, "body_md": "", "status": "current"}])])
    proj = await _run(
        pg, _embed_resp(200, []),
        event_id="e2", event_type="knowledge_article_created",
        source_table="knowledge_articles", source_row_id=ART, payload={"article_id": ART},
    )
    # DELETE still runs (clears any stale chunks); no INSERT; embedder NOT called.
    assert len(pg.sql_with("DELETE FROM wiki_chunks WHERE article_id")) == 1
    assert pg.sql_with("INSERT INTO wiki_chunks") == []
    proj._client.post.assert_not_awaited()  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_archived_event_deletes_chunks() -> None:
    pg = _FakeConn([], rowcount=5)
    proj = await _run(
        pg, None,
        event_id="e3", event_type="knowledge_article_archived",
        source_table="knowledge_articles", source_row_id=ART, payload={"article_id": ART},
    )
    assert len(pg.sql_with("DELETE FROM wiki_chunks WHERE article_id")) == 1
    # No SELECT of the article, no embed on the archive path.
    assert pg.sql_with("FROM knowledge_articles WHERE id") == []
    proj._client.post.assert_not_called()  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_archived_status_deletes_chunks() -> None:
    pg = _FakeConn([("FROM knowledge_articles WHERE id", [{"slug": "project/X", "revision": 2, "body_md": "stuff", "status": "archived"}])])
    await _run(
        pg, _embed_resp(200, [[0.1]]),
        event_id="e4", event_type="knowledge_article_revised",
        source_table="knowledge_articles", source_row_id=ART, payload={"article_id": ART},
    )
    assert len(pg.sql_with("DELETE FROM wiki_chunks WHERE article_id")) == 1
    assert pg.sql_with("INSERT INTO wiki_chunks") == []


@pytest.mark.asyncio
async def test_embedder_4xx_leaves_old_chunks() -> None:
    pg = _FakeConn([("FROM knowledge_articles WHERE id", [{"slug": "project/X", "revision": 2, "body_md": "# X\n\nbody", "status": "current"}])])
    await _run(
        pg, _embed_resp(400),
        event_id="e5", event_type="knowledge_article_revised",
        source_table="knowledge_articles", source_row_id=ART, payload={"article_id": ART},
    )
    # On a permanent embedder error we ack without touching wiki_chunks.
    assert pg.sql_with("DELETE FROM wiki_chunks WHERE article_id") == []
    assert pg.sql_with("INSERT INTO wiki_chunks") == []


@pytest.mark.asyncio
async def test_missing_article_row_is_noop() -> None:
    pg = _FakeConn([("FROM knowledge_articles WHERE id", [])])
    await _run(
        pg, _embed_resp(200, []),
        event_id="e6", event_type="knowledge_article_revised",
        source_table="knowledge_articles", source_row_id=ART, payload={"article_id": ART},
    )
    assert pg.sql_with("DELETE FROM wiki_chunks") == []
    assert pg.sql_with("INSERT INTO wiki_chunks") == []
