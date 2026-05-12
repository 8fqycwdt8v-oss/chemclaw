"""Unit tests for the wiki_regen daemon (ADR 012 Phase 2b).

Covers the parts that don't need Postgres or a real LLM: citation parsing,
human-block preservation, the LiteLLM call (stubbed httpx), the per-kind
context builders, and the apply-regen write path (fake async conn).
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from services.optimizer.wiki_regen.main import (
    Settings,
    _FALLBACK_PROMPT,
    _PermanentSkip,
    _SkipPage,
    _apply_regen,
    _ctx_compound,
    _ctx_document,
    _ctx_project,
    _ensure_human_blocks,
    _human_blocks,
    _load_prompt,
    _parse_citations,
    _synthesize,
)


# ---------------------------------------------------------------------------
# Fake async-Postgres plumbing (substring-keyed responder)
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
        self.committed = 0
        self._fetchers = fetchers

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self)

    async def commit(self) -> None:
        self.committed += 1

    def lookup(self, sql: str) -> list[dict[str, Any]]:
        for substr, rows in self._fetchers:
            if substr in sql:
                return rows
        return []

    def sql_with(self, substr: str) -> list[tuple[str, Any]]:
        return [(s, p) for (s, p) in self.calls if substr in s]


def _settings() -> Settings:
    return Settings(_env_file=None, postgres_password="x")  # type: ignore[call-arg]


# ---------------------------------------------------------------------------
# Citation parsing + human blocks
# ---------------------------------------------------------------------------


def test_parse_citations_dedup_and_kinds() -> None:
    body = (
        "Intro [fact:11111111-1111-1111-1111-111111111111]. "
        "Again [fact:11111111-1111-1111-1111-111111111111]. "
        "An experiment [experiment:ELN-NCE001-0042] and a doc "
        "[document:abcdef0123456789] and [article:project/NCE-0042]."
    )
    cites = _parse_citations(body)
    assert ("fact", "11111111-1111-1111-1111-111111111111") in cites
    assert ("experiment", "ELN-NCE001-0042") in cites
    assert ("document", "abcdef0123456789") in cites
    assert ("article", "project/NCE-0042") in cites
    # deduped on (kind, ref)
    assert sum(1 for k, _r in cites if k == "fact") == 1


def test_human_block_extraction_and_reinsertion() -> None:
    block = "<!-- human:begin owner=alice@x.com name=caveat -->Does not reproduce above 5 mmol.<!-- human:end -->"
    body = f"Old prose.\n\n{block}\n\nMore old prose."
    assert _human_blocks(body) == [block]
    new_body = "Fresh LLM body with no curator note."
    merged = _ensure_human_blocks(new_body, [block])
    assert block in merged
    assert "Curator notes" in merged
    # If already present, don't duplicate.
    assert _ensure_human_blocks(f"{new_body}\n\n{block}", [block]).count(block) == 1


# ---------------------------------------------------------------------------
# _synthesize (stubbed httpx)
# ---------------------------------------------------------------------------


def _llm_resp(status: int, content: str = "") -> MagicMock:
    r = MagicMock()
    r.status_code = status
    r.text = content
    r.json.return_value = {"choices": [{"message": {"content": content}}]}
    r.raise_for_status = MagicMock()
    return r


@pytest.mark.asyncio
async def test_synthesize_returns_body_and_strips_fence() -> None:
    client = AsyncMock()
    client.post = AsyncMock(return_value=_llm_resp(200, "```markdown\n# Page\n\nBody [fact:abc].\n```"))
    page = {"slug": "topic/x", "kind": "compound", "title": "X", "body_md": "", "has_human_edits": False}
    out = await _synthesize(client, _settings(), _FALLBACK_PROMPT, page, {"page_kind": "compound"})
    assert out.startswith("# Page")
    assert "```" not in out
    assert "[fact:abc]" in out


@pytest.mark.asyncio
async def test_synthesize_4xx_and_empty_are_skips() -> None:
    page = {"slug": "topic/x", "kind": "compound", "title": "X", "body_md": "", "has_human_edits": False}
    c1 = AsyncMock()
    c1.post = AsyncMock(return_value=_llm_resp(400, "bad request"))
    with pytest.raises(_SkipPage):
        await _synthesize(c1, _settings(), _FALLBACK_PROMPT, page, {})
    c2 = AsyncMock()
    c2.post = AsyncMock(return_value=_llm_resp(200, "   "))
    with pytest.raises(_SkipPage):
        await _synthesize(c2, _settings(), _FALLBACK_PROMPT, page, {})


@pytest.mark.asyncio
async def test_synthesize_passes_human_blocks_in_payload() -> None:
    captured: dict[str, Any] = {}

    async def fake_post(_url: str, **kw: Any) -> MagicMock:
        captured["json"] = kw["json"]
        return _llm_resp(200, "body")

    client = AsyncMock()
    client.post = fake_post
    block = "<!-- human:begin owner=a -->keep me<!-- human:end -->"
    page = {"slug": "compound/IK", "kind": "compound", "title": "X", "body_md": f"x {block}", "has_human_edits": True}
    await _synthesize(client, _settings(), _FALLBACK_PROMPT, page, {"page_kind": "compound"})
    user_msg = captured["json"]["messages"][1]["content"]
    assert "keep me" in user_msg  # human_blocks went into the prompt


# ---------------------------------------------------------------------------
# Context builders
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ctx_document_builds_outline() -> None:
    sha = "abcdef0123456789deadbeef"
    conn = _FakeConn([
        ("FROM documents WHERE sha256", [{"id": "11111111-1111-1111-1111-111111111111", "title": "SOP-042", "source_type": "SOP", "version": "1.0", "effective_date": "2026-01-01", "excerpt": "Procedure text..."}]),
        ("FROM document_chunks WHERE document_id", [{"chunk_index": 0, "heading_path": "# Intro"}, {"chunk_index": 1, "heading_path": "# Intro > ## Method"}]),
    ])
    page = {"slug": f"document/{sha[:16]}", "kind": "document_digest", "title": "SOP-042", "entity_ref": {"label": "Document", "id_property": "sha256", "id_value": sha}}
    ctx = await _ctx_document(conn, page)  # type: ignore[arg-type]
    assert ctx["document"]["cite"] == f"document:{sha[:16]}"
    assert len(ctx["outline"]) == 2


@pytest.mark.asyncio
async def test_ctx_document_missing_raises_skip() -> None:
    conn = _FakeConn([("FROM documents WHERE sha256", [])])
    page = {"slug": "document/x", "kind": "document_digest", "title": "?", "entity_ref": {"id_value": "deadbeef"}}
    with pytest.raises(_SkipPage):
        await _ctx_document(conn, page)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_ctx_bad_entity_ref_raises_permanent() -> None:
    conn = _FakeConn([])
    page = {"slug": "compound/?", "kind": "compound", "title": "?", "entity_ref": {}}
    with pytest.raises(_PermanentSkip):
        await _ctx_compound(conn, page)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_ctx_project_gathers_steps_and_hypotheses() -> None:
    conn = _FakeConn([
        ("FROM nce_projects WHERE internal_id", [{"id": "33333333-3333-3333-3333-333333333333", "name": "Aurora", "therapeutic_area": "Onc", "phase": "PC", "status": "active"}]),
        ("FROM synthetic_steps WHERE nce_project_id", [{"step_index": 1, "step_name": "Buchwald amination", "target_compound_inchikey": "RYYV..."}]),
        ("count(*) AS n FROM experiments", [{"n": 17}]),
        ("FROM hypotheses", [{"id": "44444444-4444-4444-4444-444444444444", "hypothesis_text": "Ligand X improves yield", "confidence": 0.7, "confidence_tier": "medium"}]),
    ])
    page = {"slug": "project/NCE-0042", "kind": "nce_project", "title": "Aurora", "entity_ref": {"id_value": "NCE-0042"}}
    ctx = await _ctx_project(conn, page)  # type: ignore[arg-type]
    assert ctx["experiment_count"] == 17
    assert ctx["synthetic_steps"][0]["step_name"] == "Buchwald amination"
    assert ctx["open_hypotheses"][0]["cite"].startswith("hypothesis:")


# ---------------------------------------------------------------------------
# _apply_regen
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_apply_regen_writes_revision_citations_and_log() -> None:
    conn = _FakeConn([
        ("UPDATE knowledge_articles SET", [{"revision": 3}]),
    ])
    page = {"id": "11111111-1111-1111-1111-111111111111", "slug": "project/NCE-0042", "kind": "nce_project", "dirty_reason": "experiment_imported"}
    body = "# Aurora\n\nThe Buchwald step [experiment:ELN-1] yielded well. See [fact:abc-1]."
    rev = await _apply_regen(conn, page, body)  # type: ignore[arg-type]
    assert rev == 3
    assert conn.sql_with("UPDATE knowledge_articles SET")
    assert conn.sql_with("INSERT INTO knowledge_article_revisions")
    assert conn.sql_with("INSERT INTO knowledge_article_citations")
    # The citation arrays carry the parsed (kind, ref) pairs.
    cite_call = conn.sql_with("INSERT INTO knowledge_article_citations")[0]
    assert "experiment" in cite_call[1][2] and "fact" in cite_call[1][2]
    # The `log` page was appended.
    assert any("'log'" in s and "ON CONFLICT (slug) DO UPDATE" in s for (s, _p) in conn.calls)


@pytest.mark.asyncio
async def test_apply_regen_returns_none_when_no_longer_dirty() -> None:
    conn = _FakeConn([("UPDATE knowledge_articles SET", [])])  # WHERE dirty matched nothing
    page = {"id": "11111111-1111-1111-1111-111111111111", "slug": "project/x", "kind": "nce_project", "dirty_reason": None}
    assert await _apply_regen(conn, page, "body") is None  # type: ignore[arg-type]
    # No revision / citation writes when the UPDATE was a no-op.
    assert not conn.sql_with("INSERT INTO knowledge_article_revisions")


# ---------------------------------------------------------------------------
# _load_prompt
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_load_prompt_prefers_registry_else_fallback() -> None:
    conn1 = _FakeConn([("FROM prompt_registry WHERE prompt_name = 'wiki.synthesis'", [{"template": "SEEDED PROMPT"}])])
    assert await _load_prompt(conn1) == "SEEDED PROMPT"  # type: ignore[arg-type]
    conn2 = _FakeConn([("FROM prompt_registry WHERE prompt_name = 'wiki.synthesis'", [])])
    assert await _load_prompt(conn2) == _FALLBACK_PROMPT  # type: ignore[arg-type]
