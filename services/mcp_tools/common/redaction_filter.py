"""Logging filter that runs every record's message + extras through the
LiteLLM redactor before the formatter writes it.

The LiteLLM redactor (services.litellm_redactor.redaction.redact) was
written for outbound prompts, but its rule set — bare-text SMILES,
reaction SMILES, internal compound codes (CMP-XXXX), NCE project ids,
emails — is exactly the chemistry-PII surface we never want in log
storage either. Reusing it here keeps the redaction policy in one
place: when a new pattern is added, both egress and logs benefit.

The filter is conservative: if `redact()` raises (it never should — its
input is bounded — but defense-in-depth), the original record passes
through unmodified. We log the failure once at WARNING and stop
checking for that record so a poisoned message never crashes a service.
"""

from __future__ import annotations

import logging
from typing import Any

# Late-bound import so packaging tests of common/ don't drag the redactor in.
_redact_fn: Any = None


def _redact(text: str) -> str:
    global _redact_fn
    if _redact_fn is None:
        from services.litellm_redactor.redaction import redact as _r

        _redact_fn = _r
    try:
        return _redact_fn(text).text  # type: ignore[no-any-return]
    except Exception:  # noqa: BLE001 — redactor must never crash logging
        return text


def _redact_value(value: Any) -> Any:
    """Recursively redact strings inside scalar / list / dict values."""
    if isinstance(value, str):
        return _redact(value)
    if isinstance(value, list):
        return [_redact_value(v) for v in value]
    if isinstance(value, tuple):
        return tuple(_redact_value(v) for v in value)
    if isinstance(value, dict):
        return {k: _redact_value(v) for k, v in value.items()}
    return value


# Fields the formatter must emit verbatim — stamping the redactor onto
# them would corrupt structural JSON (timestamps, levels, ids).
#
# `exc_text` / `stack_info` are intentionally NOT in this set — they are
# free-form string traceback payloads that regularly carry SMILES /
# compound codes embedded in driver error strings (e.g., psycopg
# "Failing row contains (...)"). DR-14 requires we redact them.
_PASSTHROUGH_FIELDS = frozenset(
    {
        "name",
        "msg",  # we redact the rendered message via record.getMessage()
        "args",  # we redact via the rendered message
        "levelname",
        "levelno",
        "pathname",
        "filename",
        "module",
        "exc_info",  # tuple type — handled separately below if needed
        "lineno",
        "funcName",
        "created",
        "msecs",
        "relativeCreated",
        "thread",
        "threadName",
        "processName",
        "process",
        "asctime",
        "taskName",
        "request_id",
        "session_id",
        "trace_id",
        "user",
        "service",
    }
)


class RedactionFilter(logging.Filter):
    """Run `redact()` over the record's rendered message and extra fields.

    Filters mutate the record in place, which is what we want — by the
    time the formatter sees it, every chemistry-secret string is
    placeholder-replaced.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        # Render the message once (so %-args resolve) and replace.
        rendered = record.getMessage()
        record.msg = _redact(rendered)
        # We've already substituted the args into msg above, so clear
        # them — leaving them in causes %-formatting to run a second
        # time inside the formatter and emit "%s" placeholders.
        record.args = None
        # DR-14: redact exception tracebacks before the formatter caches
        # them in `record.exc_text`. Python's logging only populates
        # `exc_text` during Formatter.format(); pre-materialise it here so
        # our redactor sees the rendered traceback string.
        if record.exc_info and record.exc_text is None:
            import traceback

            record.exc_text = _redact(
                "".join(traceback.format_exception(*record.exc_info))
            )
            # Drop exc_info so the formatter doesn't re-render and overwrite
            # our redacted exc_text on the way out.
            record.exc_info = None
        elif record.exc_text:
            record.exc_text = _redact(record.exc_text)
        if record.stack_info:
            record.stack_info = _redact(record.stack_info)
        # Walk every extra attribute; redact strings / lists / dicts.
        for k, v in list(record.__dict__.items()):
            if k in _PASSTHROUGH_FIELDS or k.startswith("_"):
                continue
            if k in ("exc_text", "stack_info"):
                continue  # already handled above
            redacted = _redact_value(v)
            if redacted is not v:
                record.__dict__[k] = redacted
        return True
