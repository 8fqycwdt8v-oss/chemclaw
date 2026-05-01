"""Per-request log correlation context.

Pairs with `services/agent-claw/src/observability/log-context.ts`. Bound
into the `add_request_id` middleware in `services/mcp_tools/common/app.py`
so every log line emitted during a request automatically carries:

  - request_id   (from incoming X-Request-Id, or a freshly generated UUID)
  - session_id   (from incoming X-Session-Id)
  - user         (sha256-hashed entra id from the JWT claim)
  - trace_id     (from the active OTel span, when one is present)
  - service      (the MCP service name)

Backed by `contextvars.ContextVar` so every awaited path inherits the
binding without explicit threading. The `LogContextFilter` copies the
current binding onto every `LogRecord` — works for stdlib logging, the
JsonFormatter from python-json-logger, and any LoggerAdapter built on
top.
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from contextvars import ContextVar, Token
from typing import Iterator, TypedDict


class LogContext(TypedDict, total=False):
    request_id: str
    session_id: str
    user: str
    trace_id: str
    service: str


_ctx: ContextVar[LogContext] = ContextVar("chemclaw_log_context", default={})


def get_log_context() -> LogContext:
    """Return the current binding (a copy — callers may not mutate)."""
    return dict(_ctx.get())  # type: ignore[return-value]


def bind_log_context(**fields: str) -> Token[LogContext]:
    """Merge `fields` onto the current context. Returns a token for
    `reset_log_context(token)` so callers can scope their bindings."""
    current = dict(_ctx.get())
    for k, v in fields.items():
        if v:
            current[k] = v
    return _ctx.set(current)  # type: ignore[arg-type]


def reset_log_context(token: Token[LogContext]) -> None:
    _ctx.reset(token)


@contextmanager
def log_context_scope(**fields: str) -> Iterator[None]:
    """Bind `fields` for the duration of the `with` block."""
    token = bind_log_context(**fields)
    try:
        yield
    finally:
        reset_log_context(token)


class LogContextFilter(logging.Filter):
    """Copies the active LogContext fields onto every record.

    Required because `python-json-logger.JsonFormatter` only emits fields
    that are present on the LogRecord — extras attached via
    `logger.info(..., extra={...})` are surfaced, but fields stored in
    contextvars are not. The filter bridges the gap: every record gets
    the current request_id / session_id / user / trace_id stamped on it
    just before the formatter runs.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        for k, v in get_log_context().items():
            if not hasattr(record, k):
                setattr(record, k, v)
        return True
