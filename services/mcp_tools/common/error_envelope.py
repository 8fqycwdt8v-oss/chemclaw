"""Unified error envelope for MCP tool services.

STATUS (2026-05-12): NOT WIRED into production. `services/mcp_tools/common/app.py`
still emits the legacy flat `{"error": <code>, "detail": ...}` shape via its
own `JSONResponse` constructions (search `ERROR_CODE_*` in app.py). The
`make_envelope` + `ErrorCode` machinery here is fully tested
(`tests/test_error_envelope.py`) and additive on the wire (new fields sit
alongside `error` / `detail`), but no FastAPI handler calls it.

`BACKLOG.md` `[mcp_tools/common]` tracks the open decision: wire this into
`app.py`'s `handle_value_error` / `handle_http_exception` /
`handle_unhandled_exception` handlers so every MCP tool returns the richer
envelope, OR drop this module + `error_codes.py`. Don't add a third
in-the-wild error shape — pick one of the two.

Pairs with `services/agent-claw/src/errors/envelope.ts`. Keeps the wire
shape additive over the existing flat `{error, detail}` so legacy
callers continue to parse it; new fields (`message`, `trace_id`,
`request_id`, `hint`) sit alongside the existing `error` (code) and
`detail` (string or object).

Wire shape:
  {
    "error":       "<code>",      # stable code string
    "message":     "<human>",
    "detail":      "...",          # optional, str or dict
    "trace_id":    "<hex>",        # optional, from active OTel span
    "request_id":  "<uuid>",       # optional, from request_id contextvar
    "hint":        "<remediation>" # optional
  }
"""

from __future__ import annotations

from typing import Any

from services.mcp_tools.common.error_codes import ErrorCode
from services.mcp_tools.common.log_context import get_log_context


def _active_trace_id() -> str | None:
    """Return the current OTel trace id when a span is active, else None.

    Imports otel lazily so common-only test runs (which don't install the
    OTel SDK in the parent venv) don't fail at import."""
    try:
        from opentelemetry.trace import get_current_span
    except ImportError:
        return None
    span = get_current_span()
    if span is None:
        return None
    sc = span.get_span_context()
    if not sc.is_valid:
        return None
    # 32-hex; reject the all-zeros invalid id.
    if sc.trace_id == 0:
        return None
    return f"{sc.trace_id:032x}"


def make_envelope(
    code: ErrorCode | str,
    message: str,
    *,
    detail: Any | None = None,
    hint: str | None = None,
) -> dict[str, Any]:
    """Build an error envelope from a code + message.

    Trace and request ids come from the currently-active OTel span /
    `LogContext` binding. Caller does not need to thread them.
    """
    code_str = code.value if isinstance(code, ErrorCode) else str(code)
    out: dict[str, Any] = {
        "error": code_str,
        "message": message,
    }
    if detail is not None:
        out["detail"] = detail
    if hint:
        out["hint"] = hint

    trace_id = _active_trace_id()
    if trace_id:
        out["trace_id"] = trace_id

    ctx = get_log_context()
    rid = ctx.get("request_id")
    if rid:
        out["request_id"] = rid

    return out


# Map of legacy short error codes (used in the existing flat envelope at
# services/mcp_tools/common/app.py:ERROR_CODE_*) to the new ErrorCode
# enum. Lets the existing handlers migrate without renaming every call
# site immediately.
LEGACY_CODE_TO_ENUM: dict[str, ErrorCode] = {
    "invalid_input": ErrorCode.MCP_BAD_REQUEST,
    "not_found": ErrorCode.MCP_NOT_FOUND,
    "not_implemented": ErrorCode.MCP_NOT_IMPLEMENTED,
    "upstream_error": ErrorCode.MCP_UPSTREAM_FAILED,
    "degraded": ErrorCode.MCP_UNAVAILABLE,
    "unauthenticated": ErrorCode.MCP_AUTH_FAILED,
    "forbidden": ErrorCode.MCP_SCOPE_DENIED,
}
