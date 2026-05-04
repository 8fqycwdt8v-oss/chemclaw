"""Tranche 5 / H5: unit tests for KgDocumentsProjector.

We mock both the Neo4j driver and the Postgres connection so the test
runs without infrastructure. The goal is to pin:
  1. Cypher shape (MERGE, deterministic fact_ids, group_id propagation).
  2. Replay idempotency (the WHERE r.invalidated_at IS NULL pattern is
     not relevant here — kg_documents writes don't carry invalidation —
     but MERGE on fact_id makes re-runs no-ops).
  3. Tenant scope flows from the document's metadata.group_id when set.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.projectors.kg_documents.main import (
    KgDocumentsProjector,
    NAMESPACE_DOCUMENT,
    NAMESPACE_CHUNK,
)


DOC_ID = "11111111-1111-1111-1111-111111111111"
CHUNK_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
CHUNK_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"


class _FakeSession:
    def __init__(self) -> None:
        self.runs: list[tuple[str, dict[str, Any]]] = []

    async def __aenter__(self) -> "_FakeSession":
        return self

    async def __aexit__(self, *_args: Any) -> None:
        return None

    async def run(self, query: str, **params: Any) -> None:
        self.runs.append((query, params))


class _FakeDriver:
    def __init__(self) -> None:
        self.session_obj = _FakeSession()

    def session(self) -> _FakeSession:
        return self.session_obj


def _pg_doc_connection(metadata_group_id: str | None = None) -> Any:
    """Postgres connection that yields a representative document + 2 chunks."""
    cur = AsyncMock()
    # First execute is SET LOCAL ROLE; we don't care about the response.
    # fetchone() is called once for the document.
    cur.fetchone = AsyncMock(
        return_value=(
            DOC_ID,                                    # id
            "Test SOP",                                # title
            "SOP",                                     # source_type
            datetime(2026, 1, 1, tzinfo=timezone.utc), # ingested_at
            metadata_group_id,                         # metadata_group_id
        )
    )
    cur.fetchall = AsyncMock(
        return_value=[
            (CHUNK_A, 0, "Section 1", "first chunk text", 12),
            (CHUNK_B, 1, "Section 2", "second chunk text", 8),
        ]
    )
    cur.__aenter__ = AsyncMock(return_value=cur)
    cur.__aexit__ = AsyncMock(return_value=None)

    conn = MagicMock()
    conn.cursor = MagicMock(return_value=cur)
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=None)
    return conn


@pytest.mark.asyncio
async def test_handle_creates_document_and_chunk_nodes_with_edges() -> None:
    settings = MagicMock()
    settings.postgres_dsn = "postgresql://stub"

    proj = KgDocumentsProjector.__new__(KgDocumentsProjector)
    proj.settings = settings  # type: ignore[attr-defined]
    proj._driver = _FakeDriver()  # type: ignore[attr-defined]

    pg = _pg_doc_connection()

    async def _connect(_dsn: str) -> Any:
        return pg

    with patch("psycopg.AsyncConnection.connect", side_effect=_connect):
        await proj.handle(
            event_id="evt-1",
            event_type="document_ingested",
            source_table="documents",
            source_row_id=DOC_ID,
            payload={},
        )

    runs = proj._driver.session_obj.runs  # type: ignore[attr-defined]
    # 1 Document MERGE + 2 Chunk MERGEs = 3 total Cypher calls.
    assert len(runs) == 3, [r[0][:60] for r in runs]

    # First Cypher creates the Document node.
    doc_q, doc_params = runs[0]
    assert "MERGE (d:Document" in doc_q
    expected_doc_fact = str(uuid.uuid5(NAMESPACE_DOCUMENT, DOC_ID))
    assert doc_params["fact_id"] == expected_doc_fact
    assert doc_params["title"] == "Test SOP"
    assert doc_params["source_type"] == "SOP"
    assert doc_params["group_id"] == "__system__"

    # Subsequent Cyphers create :Chunk nodes + HAS_CHUNK edges.
    chunk_a_q, chunk_a_params = runs[1]
    assert "MERGE (c:Chunk" in chunk_a_q
    assert "MERGE (d)-[r:HAS_CHUNK" in chunk_a_q
    expected_chunk_a_fact = str(uuid.uuid5(NAMESPACE_CHUNK, CHUNK_A))
    assert chunk_a_params["chunk_fact_id"] == expected_chunk_a_fact
    assert chunk_a_params["chunk_id"] == CHUNK_A
    assert chunk_a_params["chunk_index"] == 0
    assert chunk_a_params["heading_path"] == "Section 1"
    assert chunk_a_params["preview"] == "first chunk text"
    assert chunk_a_params["group_id"] == "__system__"


@pytest.mark.asyncio
async def test_handle_uses_metadata_group_id_when_available() -> None:
    settings = MagicMock()
    settings.postgres_dsn = "postgresql://stub"

    proj = KgDocumentsProjector.__new__(KgDocumentsProjector)
    proj.settings = settings  # type: ignore[attr-defined]
    proj._driver = _FakeDriver()  # type: ignore[attr-defined]

    pg = _pg_doc_connection(metadata_group_id="proj-NCE-007")

    async def _connect(_dsn: str) -> Any:
        return pg

    with patch("psycopg.AsyncConnection.connect", side_effect=_connect):
        await proj.handle(
            event_id="evt-1",
            event_type="document_ingested",
            source_table="documents",
            source_row_id=DOC_ID,
            payload={},
        )

    runs = proj._driver.session_obj.runs  # type: ignore[attr-defined]
    # Every node + edge carries the project-scoped group_id.
    for _query, params in runs:
        assert params.get("group_id") == "proj-NCE-007"


@pytest.mark.asyncio
async def test_handle_truncates_chunk_text_preview() -> None:
    settings = MagicMock()
    settings.postgres_dsn = "postgresql://stub"

    proj = KgDocumentsProjector.__new__(KgDocumentsProjector)
    proj.settings = settings  # type: ignore[attr-defined]
    proj._driver = _FakeDriver()  # type: ignore[attr-defined]

    long_text = "x" * 1500
    cur = AsyncMock()
    cur.fetchone = AsyncMock(
        return_value=(
            DOC_ID, "Long Doc", "report",
            datetime(2026, 1, 1, tzinfo=timezone.utc), None,
        )
    )
    cur.fetchall = AsyncMock(
        return_value=[(CHUNK_A, 0, None, long_text, 200)]
    )
    cur.__aenter__ = AsyncMock(return_value=cur)
    cur.__aexit__ = AsyncMock(return_value=None)
    conn = MagicMock()
    conn.cursor = MagicMock(return_value=cur)
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=None)

    async def _connect(_dsn: str) -> Any:
        return conn

    with patch("psycopg.AsyncConnection.connect", side_effect=_connect):
        await proj.handle(
            event_id="evt-1",
            event_type="document_ingested",
            source_table="documents",
            source_row_id=DOC_ID,
            payload={},
        )

    runs = proj._driver.session_obj.runs  # type: ignore[attr-defined]
    chunk_run = next(r for r in runs if "MERGE (c:Chunk" in r[0])
    assert len(chunk_run[1]["preview"]) == 500


@pytest.mark.asyncio
async def test_handle_skips_when_event_type_unrecognised() -> None:
    settings = MagicMock()
    settings.postgres_dsn = "postgresql://stub"
    proj = KgDocumentsProjector.__new__(KgDocumentsProjector)
    proj.settings = settings  # type: ignore[attr-defined]
    proj._driver = _FakeDriver()  # type: ignore[attr-defined]

    await proj.handle(
        event_id="evt-1",
        event_type="some_unrelated_event",
        source_table="documents",
        source_row_id=DOC_ID,
        payload={},
    )
    assert proj._driver.session_obj.runs == []  # type: ignore[attr-defined]
