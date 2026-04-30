"""LiteLLM pre_api_call callback that redacts messages before egress.

LiteLLM calls this function with kwargs that include `messages`. We
mutate `messages` in place (LiteLLM's convention) and emit a structured
log line that operators can use to gauge how often the redactor fires.

Logging policy:
  * Every call emits an `event=llm_redaction` line at INFO with the
    model name and message count.
  * `LITELLM_REDACTION_LOG_SAMPLE` (default `1`) controls sampling so
    high-volume deployments don't drown Loki — set to e.g. `100` to log
    one in every hundred calls.
  * Counts per redaction kind (SMILES, NCE, CMP, EMAIL, RXN_SMILES) are
    aggregated from the per-message `redact()` results so an operator
    can see *what* was redacted at a glance, not just *that* something
    was.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from services.litellm_redactor.redaction import redact, redact_messages

log = logging.getLogger("litellm.redactor")

_SAMPLE_EVERY = max(1, int(os.getenv("LITELLM_REDACTION_LOG_SAMPLE", "1") or "1"))
_call_count = 0


def _aggregate_counts(messages: list[Any]) -> dict[str, int]:
    """Walk message contents + assistant tool_calls and sum redaction
    counts per kind. Returns an empty dict when nothing matched.

    This is read-only — `redact_messages` (called separately by the
    callback) is what actually mutates the wire payload."""
    totals: dict[str, int] = {}

    def _bump(text: str) -> None:
        if not isinstance(text, str) or not text:
            return
        result = redact(text)
        for kind, n in result.counts.items():
            totals[kind] = totals.get(kind, 0) + n

    for m in messages:
        if not isinstance(m, dict):
            continue
        content = m.get("content")
        if isinstance(content, str):
            _bump(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    _bump(block.get("text"))
        for tc in m.get("tool_calls") or []:
            if isinstance(tc, dict):
                fn = tc.get("function") or {}
                if isinstance(fn, dict):
                    _bump(fn.get("arguments"))

    return totals


async def redactor_callback(
    kwargs: dict[str, Any],
    completion_response: Any | None = None,  # noqa: ARG001
    start_time: Any | None = None,            # noqa: ARG001
    end_time: Any | None = None,              # noqa: ARG001
) -> None:
    global _call_count
    messages = kwargs.get("messages")
    if not messages:
        return

    # Aggregate counts BEFORE mutation so the totals reflect raw input
    # (post-redaction text contains placeholder tags, not the source
    # patterns that drove them).
    counts = _aggregate_counts(messages)

    redacted = redact_messages(messages)
    kwargs["messages"] = redacted

    _call_count += 1
    # Always log when *something* was redacted so the security signal
    # never gets sampled away — the sample rate only suppresses the
    # boring "no redactions today" stream.
    if counts or _call_count % _SAMPLE_EVERY == 0:
        log.info(
            "llm redaction",
            extra={
                "event": "llm_redaction",
                "model": kwargs.get("model", "?"),
                "messages_count": len(messages),
                "redaction_counts": counts,
            },
        )
