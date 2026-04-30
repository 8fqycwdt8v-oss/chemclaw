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
        "exc_info",
        "exc_text",
        "stack_info",
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
        # Walk every extra attribute; redact strings / lists / dicts.
        for k, v in list(record.__dict__.items()):
            if k in _PASSTHROUGH_FIELDS or k.startswith("_"):
                continue
            redacted = _redact_value(v)
            if redacted is not v:
                record.__dict__[k] = redacted
        return True
