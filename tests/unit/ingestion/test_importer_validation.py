"""Pre-DB validation, hashing, and scan-loop tests for the doc_ingester.

These cover the parts of `services.ingestion.doc_ingester.importer` that can
run without a Postgres connection — the path tests already exist in
`test_importer_paths.py`; this file pins:

  - `_file_sha256` determinism + chunked-streaming behaviour on multi-block files.
  - `ingest_file` rejecting unsupported extensions BEFORE opening psycopg.
  - `ingest_file` rejecting oversized files BEFORE opening psycopg.
  - `_token_estimate` floor + length/4 heuristic.
  - `scan_and_ingest` skipping non-files / unsupported extensions and
    swallowing per-file failures so a single bad doc doesn't stop the batch.

Database-bound paths (idempotent re-ingest, ON CONFLICT, ingestion_events
emit, transaction rollback on chunk-write failure) require a live Postgres
and belong in the integration suite — out of scope here.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import pytest

from services.ingestion.doc_ingester import importer as importer_mod
from services.ingestion.doc_ingester.importer import (
    _file_sha256,
    _token_estimate,
    ingest_file,
    scan_and_ingest,
)
from services.ingestion.doc_ingester.settings import IngesterSettings


# ---------------------------------------------------------------------------
# _file_sha256
# ---------------------------------------------------------------------------


def test_file_sha256_matches_hashlib_for_small_content(tmp_path: Path) -> None:
    p = tmp_path / "small.md"
    p.write_bytes(b"hello world")
    assert _file_sha256(p) == hashlib.sha256(b"hello world").hexdigest()


def test_file_sha256_streams_files_larger_than_one_chunk(tmp_path: Path) -> None:
    """The reader uses 64 KiB chunks; verify a multi-chunk file hashes
    identically to a single-shot hashlib call so the chunking is not
    dropping bytes at boundaries."""
    p = tmp_path / "big.md"
    # 200 KiB of deterministic content — 4 chunks of 64 KiB plus a partial.
    payload = (b"A" * 1024) * 200
    p.write_bytes(payload)
    assert _file_sha256(p) == hashlib.sha256(payload).hexdigest()


def test_file_sha256_is_deterministic_across_repeated_reads(tmp_path: Path) -> None:
    p = tmp_path / "x.md"
    p.write_bytes(b"deterministic")
    assert _file_sha256(p) == _file_sha256(p)


# ---------------------------------------------------------------------------
# ingest_file pre-DB validation
# ---------------------------------------------------------------------------


def _settings_with_root(root: Path, *, max_bytes: int = 128 * 1024 * 1024) -> IngesterSettings:
    """Build settings pointing at a tmp docs_root with a sentinel DSN.

    The DSN is intentionally bogus — these tests must raise BEFORE the
    psycopg.connect call. If a test reaches the DB the connect attempt
    will fail loudly, which would itself be a regression worth catching.
    """
    return IngesterSettings(
        docs_root=root,
        max_file_bytes=max_bytes,
        postgres_host="invalid-host-do-not-resolve",
        postgres_port=1,
        postgres_db="x",
        postgres_user="x",
        postgres_password="x",
    )


def test_ingest_file_rejects_unsupported_extension(tmp_path: Path) -> None:
    s = _settings_with_root(tmp_path)
    p = tmp_path / "data.bin"
    p.write_bytes(b"not a doc")
    with pytest.raises(ValueError, match="unsupported extension"):
        ingest_file(p, settings=s)


def test_ingest_file_rejects_oversized_file(tmp_path: Path) -> None:
    s = _settings_with_root(tmp_path, max_bytes=10)
    p = tmp_path / "big.md"
    p.write_bytes(b"x" * 100)
    with pytest.raises(ValueError, match="too large"):
        ingest_file(p, settings=s)


def test_ingest_file_rejects_path_outside_root(tmp_path: Path) -> None:
    """Composition test: the path defence runs first, so an outside file
    never reaches the extension check even if its suffix is supported."""
    root = tmp_path / "docs"
    root.mkdir()
    s = _settings_with_root(root)
    outside = tmp_path / "outside.md"
    outside.write_text("hi")
    with pytest.raises(importer_mod.UnsafePathError):
        ingest_file(outside, settings=s)


# ---------------------------------------------------------------------------
# _token_estimate
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text,expected",
    [
        ("", 1),                    # floor at 1 even for empty
        ("x", 1),                   # floor at 1 below 4 chars
        ("xxx", 1),                 # still below the /4 floor
        ("xxxx", 1),                # exactly 4 chars → 1
        ("x" * 100, 25),            # 100/4 = 25
        ("x" * 4001, 1000),         # 4001/4 = 1000 (integer division)
    ],
)
def test_token_estimate_floor_and_heuristic(text: str, expected: int) -> None:
    assert _token_estimate(text) == expected


# ---------------------------------------------------------------------------
# scan_and_ingest skip + fault-tolerance behaviour
# ---------------------------------------------------------------------------


def test_scan_and_ingest_skips_non_files_and_unsupported_extensions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The scan should:
       - Skip subdirectories (is_file() filter).
       - Skip files whose extension is not in supported_extensions().
       - Pass through every supported file to ingest_file.
    """
    root = tmp_path / "docs"
    root.mkdir()
    (root / "a.md").write_text("# A")
    (root / "b.txt").write_text("plain")
    (root / "binary.bin").write_bytes(b"\x00\x01\x02")  # unsupported
    (root / "subdir").mkdir()
    (root / "subdir" / "nested.md").write_text("# N")

    seen_paths: list[Path] = []

    def fake_ingest(path: Path, *, settings: IngesterSettings) -> dict[str, Any]:
        seen_paths.append(path)
        return {"document_id": "uuid-fake", "status": "ingested", "chunk_count": 0}

    monkeypatch.setattr(importer_mod, "ingest_file", fake_ingest)
    s = _settings_with_root(root)
    results = scan_and_ingest(s)

    # rglob finds nested.md too — directories themselves are filtered by is_file().
    seen_names = sorted(p.name for p in seen_paths)
    assert seen_names == ["a.md", "b.txt", "nested.md"]
    # binary.bin was filtered out; "subdir" itself isn't a file.
    assert "binary.bin" not in seen_names
    assert len(results) == 3


def test_scan_and_ingest_continues_after_a_single_file_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One bad file must not stop the batch — the loop catches and logs.

    Pin the contract so a refactor that lets the exception bubble up (and
    aborts every doc after the first failure) trips this test.
    """
    root = tmp_path / "docs"
    root.mkdir()
    (root / "ok-1.md").write_text("# One")
    (root / "broken.md").write_text("# Broken")
    (root / "ok-2.md").write_text("# Two")

    def flaky_ingest(path: Path, *, settings: IngesterSettings) -> dict[str, Any]:
        if path.name == "broken.md":
            raise RuntimeError("simulated parser failure")
        return {"document_id": f"id-{path.stem}", "status": "ingested", "chunk_count": 1}

    monkeypatch.setattr(importer_mod, "ingest_file", flaky_ingest)
    s = _settings_with_root(root)
    results = scan_and_ingest(s)

    # The broken file was logged-and-skipped; the other two still ran.
    statuses = [r["status"] for r in results]
    assert statuses.count("ingested") == 2
    assert all(r["document_id"] in {"id-ok-1", "id-ok-2"} for r in results)


def test_scan_and_ingest_returns_empty_list_when_root_is_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "empty-docs"
    root.mkdir()
    called = False

    def fake_ingest(path: Path, *, settings: IngesterSettings) -> dict[str, Any]:
        nonlocal called
        called = True
        return {}

    monkeypatch.setattr(importer_mod, "ingest_file", fake_ingest)
    s = _settings_with_root(root)
    assert scan_and_ingest(s) == []
    assert called is False
