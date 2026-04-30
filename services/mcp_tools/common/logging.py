"""Structured logging for MCP tool services.

Switches the MCP fleet to JSON-formatted logs with two stdlib `Filter`s
attached:

  1. `LogContextFilter` (services/mcp_tools/common/log_context.py)
     copies the active per-request bindings (request_id, session_id,
     user, trace_id, service) onto every LogRecord so cross-service
     correlation works without each call site remembering to thread
     them through.

  2. `RedactionFilter` (services/mcp_tools/common/redaction_filter.py)
     runs every record's message + extras through the LiteLLM redactor
     so chemistry secrets (SMILES, compound codes, NCE project ids,
     emails) never reach Loki or any other log archive — same rules as
     outbound prompts, applied uniformly.

The format honours `LOG_LEVEL` (default INFO) and `LOG_FORMAT`:

  - `LOG_FORMAT=json` (default): one JSON object per line, with
    timestamp, level, logger name, message, and every contextvar +
    extra field. Promtail / Loki / jq parse this directly.
  - `LOG_FORMAT=pretty`: stdlib formatter (the previous plaintext
    output). Useful in `make run.*` shells where eyeballing logs is
    easier than `| jq`.

Idempotent: re-running `configure_logging()` clears the root handlers
first so uvicorn's reloader and pytest fixtures that re-import the app
factory don't accumulate duplicate handlers.
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Any

from services.mcp_tools.common.log_context import LogContextFilter
from services.mcp_tools.common.redaction_filter import RedactionFilter

# python-json-logger imports lazily so unit tests of helpers without the
# dep installed (we have one in CI without it) don't fail at import.
_JsonFormatter: Any = None


def _load_json_formatter() -> Any:
    global _JsonFormatter
    if _JsonFormatter is None:
        from pythonjsonlogger.json import JsonFormatter

        _JsonFormatter = JsonFormatter
    return _JsonFormatter


# Field set the JSON formatter advertises. python-json-logger 3.x emits
# `message`, `level`, etc., from the LogRecord; the rest are pulled from
# either `extra={}` calls or contextvar attributes the LogContextFilter
# stamps on. Listing them here makes the schema discoverable in tests.
_JSON_FIELDS = (
    "timestamp",
    "level",
    "logger",
    "message",
    "service",
    "request_id",
    "session_id",
    "user",
    "trace_id",
    "event",
    "error_code",
    "duration_ms",
)


def _build_json_handler(stream: Any) -> logging.Handler:
    JsonFormatter = _load_json_formatter()
    handler = logging.StreamHandler(stream)

    # python-json-logger renames the OUTPUT dict keys, not the LogRecord
    # attributes — so the format string here uses the original stdlib field
    # names (asctime / levelname / name) and `rename_fields` rewrites them
    # to (timestamp / level / logger) in the JSON object that ships.
    handler.setFormatter(
        JsonFormatter(
            "%(asctime)s %(levelname)s %(name)s %(message)s",
            rename_fields={
                "asctime": "timestamp",
                "levelname": "level",
                "name": "logger",
            },
            timestamp=True,  # populates record.timestamp as ISO-8601 UTC
            json_indent=None,
            json_ensure_ascii=False,
        )
    )
    return handler


def _build_pretty_handler(stream: Any) -> logging.Handler:
    handler = logging.StreamHandler(stream)
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s %(levelname)-7s %(name)s :: %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S%z",
        )
    )
    return handler


def configure_logging(level: str = "INFO", *, service: str | None = None) -> None:
    """Configure the root logger.

    Pass `service` so a global `service` field is bound onto every
    record without each handler needing to add it. Service name flows
    from `create_app(name=...)` in `services/mcp_tools/common/app.py`.
    """
    fmt = (os.getenv("LOG_FORMAT") or "json").strip().lower()
    stream = sys.stdout
    handler = _build_json_handler(stream) if fmt == "json" else _build_pretty_handler(stream)

    # Filters apply BEFORE the formatter, so contextvar fields and
    # redaction land on the record exactly where the formatter looks.
    handler.addFilter(LogContextFilter())
    handler.addFilter(RedactionFilter())

    root = logging.getLogger()
    # Clear existing handlers (e.g., uvicorn re-adds its own).
    for h in list(root.handlers):
        root.removeHandler(h)
    root.addHandler(handler)
    root.setLevel(level.upper())

    # Always-on: bind the service name onto every record via a small
    # custom filter so `service` shows up even when no per-request
    # binding has run yet (uvicorn startup, lifespan logs, etc.).
    if service:

        class _ServiceFilter(logging.Filter):
            def filter(self, record: logging.LogRecord) -> bool:
                if not getattr(record, "service", None):
                    record.service = service  # type: ignore[attr-defined]
                return True

        handler.addFilter(_ServiceFilter())

    # Quiet the noisy loggers a step.
    for noisy in ("uvicorn.access", "httpx"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
