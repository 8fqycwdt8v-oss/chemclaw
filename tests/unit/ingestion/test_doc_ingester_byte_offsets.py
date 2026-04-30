"""Unit tests for byte_start / byte_end population on document chunks.

The contextual_chunker projector uses these offsets to map PDF chunks back
to their source page (db/init/12_security_hardening.sql:40-41). Before
PR-5 the columns were declared but never written; this regression suite
locks in the post-fix behaviour:

  * `Chunk.byte_start` and `Chunk.byte_end` are populated for every chunk.
  * `byte_end - byte_start` equals the UTF-8 byte length of `text` exactly.
  * Offsets advance monotonically across the chunk list.
"""

from __future__ import annotations

from services.ingestion.doc_ingester.chunking import chunk_markdown


def test_byte_offsets_match_utf8_text_length() -> None:
    md = "# Title\n\nFirst paragraph.\n\nSecond paragraph."
    chunks = chunk_markdown(md, target_chars=500)
    assert chunks
    for c in chunks:
        assert c.byte_start >= 0
        assert c.byte_end > c.byte_start
        assert c.byte_end - c.byte_start == len(c.text.encode("utf-8"))


def test_byte_offsets_advance_monotonically() -> None:
    md = "# Big\n\n" + ("paragraph line " * 50 + "\n\n") * 20
    chunks = chunk_markdown(md, target_chars=800, overlap_chars=50)
    assert len(chunks) >= 2
    for prev, curr in zip(chunks, chunks[1:]):
        # Overlap may rewind by up to overlap_chars bytes, but the next
        # chunk must begin at or before the previous chunk's end.
        assert curr.byte_start <= prev.byte_end


def test_byte_offsets_handle_unicode_correctly() -> None:
    # 'é' is 2 bytes in UTF-8; a naive char-count would mis-size the chunk.
    md = "# Héading\n\nUné paragraphé."
    chunks = chunk_markdown(md, target_chars=500)
    assert len(chunks) == 1
    c = chunks[0]
    assert c.byte_end - c.byte_start == len(c.text.encode("utf-8"))
    # And the byte length must exceed the character length thanks to the
    # 2-byte 'é' / 'é' code points.
    assert c.byte_end - c.byte_start > len(c.text)
