"""Unit tests for Markdown chunking."""

from __future__ import annotations

import pytest

from services.ingestion.doc_ingester.chunking import Chunk, chunk_markdown


def test_empty_returns_no_chunks() -> None:
    assert chunk_markdown("", target_chars=500) == []


def test_single_short_doc_fits_in_one_chunk() -> None:
    md = "# Title\n\nShort paragraph."
    out = chunk_markdown(md, target_chars=500)
    assert len(out) == 1
    assert "Short paragraph" in out[0].text
    assert out[0].heading_path == "Title"


def test_chunks_are_contiguous_and_indexed() -> None:
    # Build a doc large enough to produce several chunks.
    md = "# Big\n\n" + ("paragraph line " * 50 + "\n\n") * 20
    out = chunk_markdown(md, target_chars=800, overlap_chars=50)
    assert len(out) >= 2
    for i, c in enumerate(out):
        assert c.index == i


def test_headings_are_hard_boundaries() -> None:
    md = (
        "# A\n\nalpha\n\n"
        "# B\n\nbeta\n\n"
        "# C\n\ngamma\n\n"
    )
    out = chunk_markdown(md, target_chars=10000, overlap_chars=0)
    # Even with a huge target, each H1 forces a new chunk.
    headings_in_chunks = [c.heading_path for c in out]
    assert "A" in headings_in_chunks
    assert "B" in headings_in_chunks
    assert "C" in headings_in_chunks


def test_heading_path_tracks_ancestry() -> None:
    md = "# Parent\n\n## Child\n\ntext under child"
    out = chunk_markdown(md, target_chars=10000, overlap_chars=0)
    # Last chunk covers the H2 section.
    child = next((c for c in out if "text under child" in c.text), None)
    assert child is not None
    assert child.heading_path == "Parent > Child"


def test_overlap_carries_tail_into_next_chunk() -> None:
    # Write a long paragraph without headings so target triggers rotation.
    text = "abcdefghij " * 200  # ~2200 chars
    out = chunk_markdown(text, target_chars=500, overlap_chars=100)
    assert len(out) >= 2
    # The tail of chunk[i] must appear at the start of chunk[i+1].
    tail = out[0].text[-100:]
    assert tail in out[1].text


def test_rejects_invalid_params() -> None:
    with pytest.raises(ValueError):
        chunk_markdown("x", target_chars=0)
    with pytest.raises(ValueError):
        chunk_markdown("x", target_chars=100, overlap_chars=-1)
    with pytest.raises(ValueError):
        chunk_markdown("x", target_chars=100, overlap_chars=100)


def test_chunk_type_is_frozen() -> None:
    c = Chunk(index=0, heading_path="A", text="x")
    with pytest.raises(Exception):
        c.index = 1  # type: ignore[misc]
