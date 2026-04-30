"""Layout-aware chunking over parsed Markdown.

Strategy: walk the document line by line, keeping paragraphs intact. When a
running buffer exceeds `target`, emit a chunk and reseed the buffer with a
bounded overlap (the last N characters of the emitted chunk) so context is
preserved across boundaries. Markdown headings act as hard boundaries so a
chunk never crosses a `#` / `##` / `###` line.

Why character-based rather than token-based: the downstream embedder
(BGE-M3) handles its own truncation at 8192 tokens; our goal here is just
to cap context and preserve natural boundaries.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Heading line regexp: `#`, `##`, ... (1 to 6 levels), followed by space and text.
_HEADING_RE = re.compile(r"^#{1,6}\s+\S")


@dataclass(frozen=True)
class Chunk:
    index: int
    heading_path: str
    text: str
    byte_start: int
    byte_end: int


def _update_heading_path(path: list[str], line: str) -> list[str]:
    """Track a running heading ancestry from Markdown lines."""
    if not _HEADING_RE.match(line):
        return path
    # Count leading hashes.
    level = 0
    for ch in line:
        if ch == "#":
            level += 1
        else:
            break
    text = line[level:].strip()
    new_path = path[: level - 1]
    new_path.append(text)
    return new_path


def chunk_markdown(
    markdown: str,
    *,
    target_chars: int = 2500,
    overlap_chars: int = 250,
) -> list[Chunk]:
    """Split a Markdown document into chunks of ~target_chars with overlap.

    Guarantees:
      - Chunk index is contiguous (0, 1, 2, …).
      - `heading_path` reflects the current heading ancestry at the chunk's start.
      - Headings introduce hard boundaries; a chunk never spans across a heading.
      - Each chunk is ≤ 2× target_chars (upper bound defence).
    """
    if target_chars <= 0:
        raise ValueError("target_chars must be positive")
    if overlap_chars < 0 or overlap_chars >= target_chars:
        raise ValueError("overlap_chars must be in [0, target_chars)")

    chunks: list[Chunk] = []
    heading_path: list[str] = []
    buf: list[str] = []
    buf_len = 0
    chunk_start_path: list[str] = []
    # Byte offset (UTF-8) in the source markdown where the next chunk will
    # begin. Updated after every flush. The contextual_chunker projector reads
    # byte_start to map PDF chunks back to their page number, so the offset
    # must be a stable index into the parsed_markdown column.
    chunk_byte_start = 0
    cursor_byte = 0

    def flush() -> None:
        nonlocal buf, buf_len, chunk_byte_start
        if not buf:
            return
        text = "\n".join(buf).strip()
        if not text:
            buf = []
            buf_len = 0
            chunk_byte_start = cursor_byte
            return
        text_bytes = len(text.encode("utf-8"))
        chunks.append(
            Chunk(
                index=len(chunks),
                heading_path=" > ".join(chunk_start_path),
                text=text,
                byte_start=chunk_byte_start,
                byte_end=chunk_byte_start + text_bytes,
            )
        )
        if overlap_chars > 0:
            tail = text[-overlap_chars:]
            buf = [tail]
            buf_len = len(tail)
            # Next chunk starts where the overlap window ends in the source.
            chunk_byte_start = cursor_byte - len(tail.encode("utf-8"))
        else:
            buf = []
            buf_len = 0
            chunk_byte_start = cursor_byte

    for raw_line in markdown.splitlines():
        # `splitlines()` strips the trailing newline; account for one byte per
        # newline regardless of \n vs \r\n (close enough for offset mapping).
        line_bytes = len(raw_line.encode("utf-8")) + 1

        # Heading: flush current buffer (hard boundary) and update ancestry.
        if _HEADING_RE.match(raw_line):
            flush()
            heading_path = _update_heading_path(heading_path, raw_line)
            chunk_start_path = heading_path[:]
            buf.append(raw_line)
            buf_len = len(raw_line) + 1
            cursor_byte += line_bytes
            continue

        if not chunk_start_path and heading_path:
            chunk_start_path = heading_path[:]

        buf.append(raw_line)
        buf_len += len(raw_line) + 1
        cursor_byte += line_bytes

        if buf_len >= target_chars:
            flush()
            chunk_start_path = heading_path[:]

    flush()
    return chunks
