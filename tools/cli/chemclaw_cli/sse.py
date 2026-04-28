"""Line-based Server-Sent Events parser.

Pure function: takes an iterable of already-decoded lines (no trailing
newlines), yields events. No I/O, no global state, no httpx coupling.

Conforms to the subset of the SSE spec that agent-claw emits:
  - Each event is one or more `data:` lines followed by a blank line.
  - Lines starting with `:` are comments and ignored.
  - All other field names (`event:`, `id:`, `retry:`) are accepted but
    not used.

DoS guard: a misbehaving / compromised agent-claw could otherwise stream a
single multi-GB ``data:`` block and OOM the CLI. We cap individual lines
at 256 KiB and the accumulated event payload at 2 MiB; either overflow
raises ``SseFrameTooLargeError`` so the calling command can surface a
clean error rather than getting killed by the OOM-killer.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator
from typing import Any


# These caps are far above any legitimate agent-claw event (text deltas
# are sub-KB, even big tool-result payloads sit comfortably under 100 KB
# after the redactor runs).
_MAX_LINE_BYTES = 256 * 1024
_MAX_EVENT_BYTES = 2 * 1024 * 1024


class SseFrameTooLargeError(ValueError):
    """Raised when an SSE line or event payload exceeds the safety cap."""


def parse_sse_lines(
    lines: Iterable[str],
    *,
    parse_json: bool = True,
) -> Iterator[Any]:
    """Yield one event per blank-line-terminated SSE message.

    Args:
        lines: an iterable of decoded lines without trailing newlines.
        parse_json: when True (default), each event's data is run
            through json.loads. When False, the raw joined data string
            is yielded — useful for tests of the framing logic itself.

    Raises:
        SseFrameTooLargeError: if a single line or accumulated data buffer
            exceeds the per-line / per-event byte caps.
        ValueError: if parse_json=True and a data block is not valid JSON.
    """
    data_buf: list[str] = []
    data_buf_bytes = 0
    for line in lines:
        # `len(line)` measures characters, not bytes — for an ASCII-heavy
        # event stream this is a tight enough approximation; UTF-8 multi-
        # byte characters cost more bytes on the wire but the length test
        # still bounds memory in the CLI. Encoding to UTF-8 just to count
        # bytes per line would double work for no security gain.
        if len(line) > _MAX_LINE_BYTES:
            raise SseFrameTooLargeError(
                f"SSE line exceeds {_MAX_LINE_BYTES}-byte cap "
                f"(got {len(line)}); refusing to buffer"
            )
        if line == "":
            if data_buf:
                payload = "\n".join(data_buf)
                yield json.loads(payload) if parse_json else payload
                data_buf = []
                data_buf_bytes = 0
            continue
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            chunk = line[5:]
            if chunk.startswith(" "):
                chunk = chunk[1:]
            data_buf_bytes += len(chunk) + 1  # +1 for the join newline
            if data_buf_bytes > _MAX_EVENT_BYTES:
                raise SseFrameTooLargeError(
                    f"SSE event payload exceeds {_MAX_EVENT_BYTES}-byte cap "
                    f"(got {data_buf_bytes}); refusing to accumulate further"
                )
            data_buf.append(chunk)
            continue
        # Other field lines (event:, id:, retry:) — agent-claw doesn't
        # use them, ignore silently.
