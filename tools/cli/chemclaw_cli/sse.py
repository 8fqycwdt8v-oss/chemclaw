"""Line-based Server-Sent Events parser.

Pure function: takes an iterable of already-decoded lines (no trailing
newlines), yields events. No I/O, no global state, no httpx coupling.

Conforms to the subset of the SSE spec that agent-claw emits:
  - Each event is one or more `data:` lines followed by a blank line.
  - Lines starting with `:` are comments and ignored.
  - All other field names (`event:`, `id:`, `retry:`) are accepted but
    not used.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator
from typing import Any


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
        ValueError: if parse_json=True and a data block is not valid JSON.
    """
    data_buf: list[str] = []
    for line in lines:
        if line == "":
            if data_buf:
                payload = "\n".join(data_buf)
                yield json.loads(payload) if parse_json else payload
                data_buf = []
            continue
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            chunk = line[5:]
            if chunk.startswith(" "):
                chunk = chunk[1:]
            data_buf.append(chunk)
            continue
        # Other field lines (event:, id:, retry:) — agent-claw doesn't
        # use them, ignore silently.
