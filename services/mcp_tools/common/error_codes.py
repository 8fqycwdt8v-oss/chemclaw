"""Stable error code enum mirroring services/agent-claw/src/errors/codes.ts.

Used by:
  - the unified error envelope (`error_envelope.py`)
  - the per-service exception handlers in `app.py`
  - the `error_events` DB sink

Adding a code requires matching the TS list. A parity test is added in
`tests/parity/test_error_codes_parity.py` if/when one is needed.
"""

from __future__ import annotations

from enum import Enum


class ErrorCode(str, Enum):
    # --- Agent / harness ---------------------------------------------------
    AGENT_BUDGET_EXCEEDED = "AGENT_BUDGET_EXCEEDED"
    SESSION_BUDGET_EXCEEDED = "SESSION_BUDGET_EXCEEDED"
    AGENT_AWAITING_USER_INPUT = "AGENT_AWAITING_USER_INPUT"
    AGENT_OPTIMISTIC_LOCK = "AGENT_OPTIMISTIC_LOCK"
    AGENT_PLAN_PARSE_FAILED = "AGENT_PLAN_PARSE_FAILED"
    AGENT_HOOK_FAILED = "AGENT_HOOK_FAILED"
    AGENT_TOOL_FAILED = "AGENT_TOOL_FAILED"
    AGENT_CONFIG_INVALID = "AGENT_CONFIG_INVALID"
    AGENT_UNAUTHENTICATED = "AGENT_UNAUTHENTICATED"
    AGENT_INTERNAL = "AGENT_INTERNAL"
    AGENT_CANCELLED = "AGENT_CANCELLED"
    AGENT_INVALID_INPUT = "AGENT_INVALID_INPUT"

    # --- MCP services ------------------------------------------------------
    MCP_BAD_REQUEST = "MCP_BAD_REQUEST"
    MCP_NOT_FOUND = "MCP_NOT_FOUND"
    MCP_NOT_IMPLEMENTED = "MCP_NOT_IMPLEMENTED"
    MCP_UPSTREAM_FAILED = "MCP_UPSTREAM_FAILED"
    MCP_UNAVAILABLE = "MCP_UNAVAILABLE"
    MCP_TIMEOUT = "MCP_TIMEOUT"
    MCP_AUTH_FAILED = "MCP_AUTH_FAILED"
    MCP_SCOPE_DENIED = "MCP_SCOPE_DENIED"
    MCP_REDACTION_FAILED = "MCP_REDACTION_FAILED"

    # --- Database / RLS ----------------------------------------------------
    DB_RLS_DENIED = "DB_RLS_DENIED"
    DB_RLS_NO_USER_CONTEXT = "DB_RLS_NO_USER_CONTEXT"
    DB_OPTIMISTIC_LOCK = "DB_OPTIMISTIC_LOCK"
    DB_RECONNECT = "DB_RECONNECT"
    DB_SLOW_QUERY = "DB_SLOW_QUERY"

    # --- Projectors --------------------------------------------------------
    PROJECTOR_HANDLER_FAILED_TRANSIENT = "PROJECTOR_HANDLER_FAILED_TRANSIENT"
    PROJECTOR_HANDLER_FAILED_PERMANENT = "PROJECTOR_HANDLER_FAILED_PERMANENT"

    # --- Paperclip ---------------------------------------------------------
    PAPERCLIP_BUDGET_DENIED = "PAPERCLIP_BUDGET_DENIED"
    PAPERCLIP_PERSIST_FAILED = "PAPERCLIP_PERSIST_FAILED"

    # --- LLM ---------------------------------------------------------------
    LLM_REDACTION_FAILED = "LLM_REDACTION_FAILED"
    LLM_PROVIDER_FAILED = "LLM_PROVIDER_FAILED"
