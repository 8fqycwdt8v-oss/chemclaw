"""Unit tests for the Streamlit chat client's SSE parser.

We don't spin up an HTTP server — we feed the parser synthetic line streams
that exercise the edge cases: multi-line frames, comments, empty lines,
malformed JSON, trailing data without terminator.
"""

from __future__ import annotations

from typing import Any

from services.frontend.chat_client import _iter_sse_events


class _FakeResponse:
    """Minimal httpx.Response stand-in exposing `iter_lines()`."""

    def __init__(self, lines: list[str]) -> None:
        self._lines = lines

    def iter_lines(self):
        yield from self._lines


def _collect(lines: list[str]) -> list[dict[str, Any]]:
    return list(_iter_sse_events(_FakeResponse(lines)))  # type: ignore[arg-type]


def test_parses_single_event() -> None:
    events = _collect(['data: {"type":"text_delta","delta":"hi"}', ""])
    assert events == [{"type": "text_delta", "delta": "hi"}]


def test_parses_multiple_events_separated_by_blank_line() -> None:
    events = _collect(
        [
            'data: {"type":"text_delta","delta":"hel"}',
            "",
            'data: {"type":"text_delta","delta":"lo"}',
            "",
            'data: {"type":"finish","finishReason":"stop","usage":{},"promptVersion":1}',
            "",
        ]
    )
    assert len(events) == 3
    assert events[2]["type"] == "finish"


def test_ignores_sse_comments() -> None:
    events = _collect([":keepalive", 'data: {"type":"finish","finishReason":"s","usage":{},"promptVersion":1}', ""])
    assert len(events) == 1


def test_ignores_malformed_json_frames() -> None:
    events = _collect(["data: {malformed", "", 'data: {"type":"text_delta","delta":"x"}', ""])
    # Malformed dropped; valid passed through.
    assert events == [{"type": "text_delta", "delta": "x"}]


def test_flushes_trailing_buffer_without_blank_line() -> None:
    events = _collect(['data: {"type":"finish","finishReason":"stop","usage":{},"promptVersion":1}'])
    assert len(events) == 1
    assert events[0]["type"] == "finish"


def test_non_dict_payload_ignored() -> None:
    # e.g., the server shouldn't send this, but we don't want to crash.
    events = _collect(["data: 42", "", "data: null", ""])
    assert events == []
