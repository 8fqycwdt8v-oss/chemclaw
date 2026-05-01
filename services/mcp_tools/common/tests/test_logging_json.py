"""End-to-end shape tests for `configure_logging()` in JSON mode.

Captures the rendered output via a StringIO handler installed AFTER
`configure_logging()` so the tests assert the exact JSON that ships to
stdout in production.
"""

from __future__ import annotations

import json
import logging
import os
from io import StringIO

import pytest

from services.mcp_tools.common.log_context import log_context_scope
from services.mcp_tools.common.logging import configure_logging


def _capture_root_handler_output() -> StringIO:
    """`configure_logging()` writes to sys.stdout via a StreamHandler.
    Replace its stream with a StringIO so tests can read what was
    written without poisoning real stdout (pytest -s would still work
    but we want the captured bytes for assertions)."""
    root = logging.getLogger()
    assert root.handlers, "configure_logging() didn't install a handler"
    handler = root.handlers[0]
    buf = StringIO()
    handler.stream = buf  # type: ignore[attr-defined]
    return buf


@pytest.fixture(autouse=True)
def _isolate_root_logger() -> None:
    saved = list(logging.getLogger().handlers)
    saved_level = logging.getLogger().level
    yield
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)
    for h in saved:
        root.addHandler(h)
    root.setLevel(saved_level)


def test_json_format_emits_one_object_per_line() -> None:
    os.environ["LOG_FORMAT"] = "json"
    try:
        configure_logging("INFO", service="mcp-test")
        buf = _capture_root_handler_output()
        logging.getLogger("test").info("hello world")
        line = buf.getvalue().strip()
        # Must parse as a single JSON object.
        record = json.loads(line)
        assert record["level"] == "INFO"
        assert record["logger"] == "test"
        assert record["message"] == "hello world"
        assert record["service"] == "mcp-test"
        assert "timestamp" in record
    finally:
        del os.environ["LOG_FORMAT"]


def test_json_record_carries_log_context_fields() -> None:
    os.environ["LOG_FORMAT"] = "json"
    try:
        configure_logging("INFO", service="mcp-test")
        buf = _capture_root_handler_output()
        with log_context_scope(request_id="req-Z", user="u-hash", trace_id="t-1"):
            logging.getLogger("ctx").info("hi")
        record = json.loads(buf.getvalue().strip())
        assert record["request_id"] == "req-Z"
        assert record["user"] == "u-hash"
        assert record["trace_id"] == "t-1"
    finally:
        del os.environ["LOG_FORMAT"]


def test_json_record_redacts_chemistry_pii_in_message() -> None:
    os.environ["LOG_FORMAT"] = "json"
    try:
        configure_logging("INFO", service="mcp-test")
        buf = _capture_root_handler_output()
        logging.getLogger("redact").info(
            "Compound CMP-123456 with SMILES CC(=O)Oc1ccccc1C(=O)O processed"
        )
        record = json.loads(buf.getvalue().strip())
        assert "CMP-123456" not in record["message"]
        assert "CC(=O)Oc1ccccc1C(=O)O" not in record["message"]
    finally:
        del os.environ["LOG_FORMAT"]


def test_pretty_format_emits_plain_text() -> None:
    os.environ["LOG_FORMAT"] = "pretty"
    try:
        configure_logging("INFO", service="mcp-test")
        buf = _capture_root_handler_output()
        logging.getLogger("pretty").info("hello pretty")
        line = buf.getvalue().strip()
        # Pretty mode emits the historical plaintext shape.
        assert "INFO" in line
        assert "pretty" in line
        assert "hello pretty" in line
        # Not JSON.
        with pytest.raises(json.JSONDecodeError):
            json.loads(line)
    finally:
        del os.environ["LOG_FORMAT"]


def test_extra_event_field_lands_in_json() -> None:
    os.environ["LOG_FORMAT"] = "json"
    try:
        configure_logging("INFO", service="mcp-test")
        buf = _capture_root_handler_output()
        logging.getLogger("ev").info(
            "tool succeeded",
            extra={"event": "tool_invoked", "tool_id": "compute_drfp", "duration_ms": 42},
        )
        record = json.loads(buf.getvalue().strip())
        assert record["event"] == "tool_invoked"
        assert record["tool_id"] == "compute_drfp"
        assert record["duration_ms"] == 42
    finally:
        del os.environ["LOG_FORMAT"]
