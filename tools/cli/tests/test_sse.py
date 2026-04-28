"""Tests for the line-based SSE parser."""

from __future__ import annotations

import pytest

from chemclaw_cli.sse import parse_sse_lines


def test_parses_single_data_event() -> None:
    lines = [
        'data: {"type":"text_delta","delta":"hi"}',
        "",
    ]
    events = list(parse_sse_lines(iter(lines)))
    assert events == [{"type": "text_delta", "delta": "hi"}]


def test_parses_multiple_events() -> None:
    lines = [
        'data: {"type":"text_delta","delta":"a"}',
        "",
        'data: {"type":"text_delta","delta":"b"}',
        "",
        'data: {"type":"finish","finishReason":"stop","usage":{"promptTokens":1,"completionTokens":1}}',
        "",
    ]
    events = list(parse_sse_lines(iter(lines)))
    assert [e["type"] for e in events] == ["text_delta", "text_delta", "finish"]
    assert events[1]["delta"] == "b"


def test_handles_multiline_data_per_spec() -> None:
    """Per the SSE spec, multiple `data:` lines join with `\\n`."""
    lines = [
        "data: line one",
        "data: line two",
        "",
    ]
    events = list(parse_sse_lines(iter(lines), parse_json=False))
    assert events == ["line one\nline two"]


def test_skips_keepalive_comments() -> None:
    lines = [
        ": keepalive",
        'data: {"type":"text_delta","delta":"x"}',
        "",
    ]
    events = list(parse_sse_lines(iter(lines)))
    assert events == [{"type": "text_delta", "delta": "x"}]


def test_ignores_unknown_field_lines() -> None:
    """`event:` and `id:` are valid SSE fields but unused by agent-claw."""
    lines = [
        "event: ignored",
        "id: 42",
        'data: {"type":"text_delta","delta":"y"}',
        "",
    ]
    events = list(parse_sse_lines(iter(lines)))
    assert events == [{"type": "text_delta", "delta": "y"}]


def test_no_trailing_blank_yields_partial_event() -> None:
    """If the connection closes mid-event, the half-built event is dropped."""
    lines = ['data: {"type":"text_delta","delta":"partial"}']
    events = list(parse_sse_lines(iter(lines)))
    assert events == []


def test_invalid_json_raises_on_parse() -> None:
    """When parse_json=True (the default), bad JSON propagates as ValueError."""
    lines = ["data: not-json", ""]
    with pytest.raises(ValueError):
        list(parse_sse_lines(iter(lines)))


def test_data_with_no_space_after_colon_still_parses() -> None:
    """Per the SSE spec, the single space after the colon is optional."""
    lines = ['data:{"type":"text_delta","delta":"z"}', ""]
    events = list(parse_sse_lines(iter(lines)))
    assert events == [{"type": "text_delta", "delta": "z"}]
