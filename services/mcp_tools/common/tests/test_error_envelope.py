"""Tests for the unified error envelope in services.mcp_tools.common.error_envelope."""

from __future__ import annotations

import pytest

from services.mcp_tools.common.error_codes import ErrorCode
from services.mcp_tools.common.error_envelope import (
    LEGACY_CODE_TO_ENUM,
    make_envelope,
)
from services.mcp_tools.common.log_context import log_context_scope


def test_envelope_carries_code_and_message() -> None:
    env = make_envelope(ErrorCode.MCP_TIMEOUT, "tool timed out")
    assert env["error"] == "MCP_TIMEOUT"
    assert env["message"] == "tool timed out"


def test_envelope_accepts_string_code() -> None:
    env = make_envelope("CUSTOM_CODE", "msg")
    assert env["error"] == "CUSTOM_CODE"


def test_envelope_optional_fields_are_omitted_when_none() -> None:
    env = make_envelope(ErrorCode.MCP_BAD_REQUEST, "bad")
    for absent in ("detail", "hint", "trace_id", "request_id"):
        assert absent not in env, f"{absent} should be absent when not supplied"


def test_envelope_includes_request_id_from_log_context() -> None:
    with log_context_scope(request_id="req-Z"):
        env = make_envelope(ErrorCode.MCP_BAD_REQUEST, "bad")
        assert env["request_id"] == "req-Z"


def test_envelope_attaches_detail_and_hint() -> None:
    env = make_envelope(
        ErrorCode.MCP_UPSTREAM_FAILED,
        "AskCOS service down",
        detail={"upstream_status": 503},
        hint="retry in 30s",
    )
    assert env["detail"] == {"upstream_status": 503}
    assert env["hint"] == "retry in 30s"


def test_legacy_codes_map_to_new_enum() -> None:
    """Existing services emit `error: invalid_input` etc. The migration
    mapping must preserve every legacy short code so a follow-up pass
    can flip them to the new strings."""
    for legacy, new in LEGACY_CODE_TO_ENUM.items():
        assert isinstance(new, ErrorCode), f"{legacy} did not map to an ErrorCode"


def test_envelope_does_not_leak_raw_log_context_values() -> None:
    """Defensive — `make_envelope` only reads `request_id` from context;
    other contextvar fields (user, session_id) must not appear in the
    envelope (they're for log records, not error responses sent to
    clients)."""
    with log_context_scope(request_id="r1", session_id="s1", user="u-hash"):
        env = make_envelope(ErrorCode.MCP_BAD_REQUEST, "bad")
        assert "session_id" not in env
        assert "user" not in env


@pytest.mark.parametrize(
    "code",
    [
        ErrorCode.AGENT_INTERNAL,
        ErrorCode.MCP_TIMEOUT,
        ErrorCode.DB_RLS_DENIED,
        ErrorCode.PROJECTOR_HANDLER_FAILED_TRANSIENT,
    ],
)
def test_round_trip_through_string_value(code: ErrorCode) -> None:
    env = make_envelope(code, "x")
    # `error` must always be a plain string at the wire — never the enum
    # repr — so JSON serialization is straightforward.
    assert isinstance(env["error"], str)
    assert env["error"] == code.value
