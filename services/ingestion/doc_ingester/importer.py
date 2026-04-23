"""Document ingestion orchestration.

Given a file path (inside `docs_root`), this module:
  1. Validates size + path containment (no traversal).
  2. Computes SHA-256 — used as the primary ID for idempotency.
  3. Parses via the dispatcher (`parsers.parse_document`).
  4. Chunks via `chunking.chunk_markdown`.
  5. Writes to `documents` + `document_chunks` in a single transaction.
  6. Emits a `document_ingested` event per document.

Idempotency: documents are keyed by SHA-256. Re-ingesting the same file is
a no-op (ON CONFLICT DO NOTHING on the documents insert; chunks are
linked by document_id so they are either all-new or not written at all).
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from services.ingestion.doc_ingester.chunking import chunk_markdown
from services.ingestion.doc_ingester.parsers import parse_document, supported_extensions
from services.ingestion.doc_ingester.settings import IngesterSettings

log = logging.getLogger("doc_ingester.importer")


class UnsafePathError(ValueError):
    """Raised when a submitted path escapes `docs_root`."""


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def _resolve_under_root(candidate: Path, root: Path) -> Path:
    """Reject any path that is not inside `root`. Symlinks resolved."""
    resolved = candidate.resolve(strict=True)
    root_resolved = root.resolve(strict=True)
    try:
        resolved.relative_to(root_resolved)
    except ValueError as exc:
        raise UnsafePathError(
            f"path {candidate!r} is not inside {root_resolved!r}"
        ) from exc
    return resolved


def ingest_file(path: Path, *, settings: IngesterSettings | None = None) -> dict[str, Any]:
    """Ingest one document. Returns a small result dict for the caller."""
    s = settings or IngesterSettings()
    resolved = _resolve_under_root(path, s.docs_root)

    if resolved.suffix.lower() not in supported_extensions():
        raise ValueError(f"unsupported extension: {resolved.suffix}")

    size = resolved.stat().st_size
    if size > s.max_file_bytes:
        raise ValueError(f"file too large: {size} > {s.max_file_bytes}")

    sha = _file_sha256(resolved)
    title, markdown, source_type = parse_document(resolved)
    chunks = chunk_markdown(
        markdown,
        target_chars=s.chunk_size_chars,
        overlap_chars=s.chunk_overlap_chars,
    )

    with psycopg.connect(s.postgres_dsn, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT set_config('app.current_user_entra_id', '', false)")

            cur.execute(
                """
                INSERT INTO documents (sha256, title, source_type, source_path,
                                       parsed_markdown, metadata)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (sha256) DO NOTHING
                RETURNING id::text
                """,
                (
                    sha,
                    title,
                    source_type,
                    str(resolved),
                    markdown,
                    Jsonb({"chunk_count": len(chunks)}),
                ),
            )
            row = cur.fetchone()
            if row is None:
                # Already ingested — fetch its id and skip chunk/event writes.
                cur.execute(
                    "SELECT id::text FROM documents WHERE sha256 = %s", (sha,)
                )
                existing = cur.fetchone()
                if existing is None:
                    raise RuntimeError("document race: neither inserted nor found")
                log.info("doc %s already ingested (sha=%s...)", resolved.name, sha[:12])
                return {
                    "document_id": existing["id"],
                    "status": "already_ingested",
                    "chunk_count": 0,
                }
            document_id = row["id"]

            # Insert chunks in one executemany for efficiency.
            cur.executemany(
                """
                INSERT INTO document_chunks
                  (document_id, chunk_index, heading_path, text, token_count)
                VALUES (%s::uuid, %s, %s, %s, %s)
                """,
                [
                    (document_id, c.index, c.heading_path, c.text, _token_estimate(c.text))
                    for c in chunks
                ],
            )

            cur.execute(
                """
                INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
                VALUES ('document_ingested', 'documents', %s::uuid, %s)
                """,
                (
                    document_id,
                    Jsonb({"sha256": sha, "chunk_count": len(chunks), "source_type": source_type}),
                ),
            )
        conn.commit()

    log.info(
        "ingested %s: document_id=%s chunks=%d source_type=%s",
        resolved.name, document_id, len(chunks), source_type,
    )
    return {"document_id": document_id, "status": "ingested", "chunk_count": len(chunks)}


def _token_estimate(text: str) -> int:
    """Cheap, locale-agnostic token count: ~= len(text)/4 heuristic."""
    return max(1, len(text) // 4)


def scan_and_ingest(settings: IngesterSettings | None = None) -> list[dict[str, Any]]:
    """One-shot scan of `docs_root` for supported files. Idempotent."""
    s = settings or IngesterSettings()
    results: list[dict[str, Any]] = []
    supported = supported_extensions()
    for path in sorted(s.docs_root.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in supported:
            continue
        try:
            results.append(ingest_file(path, settings=s))
        except Exception as exc:  # noqa: BLE001 — continue on single-file failures
            log.warning("ingest failed for %s: %s", path, exc)
    return results
