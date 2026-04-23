"""Unit tests for the doc_ingester parser dispatch layer."""

from __future__ import annotations

from pathlib import Path

import pytest

from services.ingestion.doc_ingester.parsers import (
    UnsupportedFormatError,
    infer_source_type,
    parse_document,
    supported_extensions,
)


def test_supported_extensions_contains_expected() -> None:
    exts = supported_extensions()
    assert {".pdf", ".docx", ".md", ".markdown", ".txt"} <= exts


@pytest.mark.parametrize(
    "stem,expected",
    [
        ("method-validation-2026-Q1", "method_validation"),
        ("My-SOP-v3", "SOP"),
        ("project_report", "report"),
        ("LiteratureSummary_PdCat", "literature_summary"),
        ("some-slide-deck.pptx", "presentation"),  # .pptx triggers presentation rule
        ("random_file", "other"),
    ],
)
def test_infer_source_type(stem: str, expected: str) -> None:
    # Append a fake extension so the dispatcher has one.
    path = Path(f"/tmp/{stem}.md")
    assert infer_source_type(path) == expected


def test_unknown_extension_raises(tmp_path: Path) -> None:
    f = tmp_path / "what.zzz"
    f.write_text("hi")
    with pytest.raises(UnsupportedFormatError):
        parse_document(f)


def test_markdown_roundtrip(tmp_path: Path) -> None:
    f = tmp_path / "note.md"
    f.write_text("# My Title\n\nhello world", encoding="utf-8")
    title, md, stype = parse_document(f)
    assert title == "My Title"
    assert "hello world" in md
    assert stype == "other"


def test_txt_prepends_heading_when_absent(tmp_path: Path) -> None:
    f = tmp_path / "notes.txt"
    f.write_text("plain content, no heading", encoding="utf-8")
    title, md, stype = parse_document(f)
    assert title == "notes"
    assert md.startswith("# notes")


def test_txt_leaves_existing_heading(tmp_path: Path) -> None:
    f = tmp_path / "notes.txt"
    f.write_text("# Already here\n\nbody", encoding="utf-8")
    _, md, _ = parse_document(f)
    assert md.startswith("# Already here")
