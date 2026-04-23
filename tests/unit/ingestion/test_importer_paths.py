"""Unit tests for the path-containment defences in the ingester.

These run without a Postgres connection — we only exercise helpers that
decide whether a file is acceptable.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from services.ingestion.doc_ingester.importer import (
    UnsafePathError,
    _resolve_under_root,
)


def test_accepts_file_under_root(tmp_path: Path) -> None:
    root = tmp_path / "docs"
    root.mkdir()
    f = root / "hello.md"
    f.write_text("x")
    got = _resolve_under_root(f, root)
    assert got == f.resolve()


def test_rejects_file_outside_root(tmp_path: Path) -> None:
    root = tmp_path / "docs"
    root.mkdir()
    outside = tmp_path / "outside.md"
    outside.write_text("x")
    with pytest.raises(UnsafePathError):
        _resolve_under_root(outside, root)


def test_rejects_symlink_escape(tmp_path: Path) -> None:
    root = tmp_path / "docs"
    root.mkdir()
    target = tmp_path / "secret.md"
    target.write_text("nope")
    link = root / "link.md"
    link.symlink_to(target)
    with pytest.raises(UnsafePathError):
        _resolve_under_root(link, root)


def test_rejects_dotdot_traversal(tmp_path: Path) -> None:
    root = tmp_path / "docs"
    root.mkdir()
    target = tmp_path / "outside.md"
    target.write_text("hi")
    sneaky = root / ".." / "outside.md"
    with pytest.raises(UnsafePathError):
        _resolve_under_root(sneaky, root)
