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
    aggregated by `redact_messages_with_counts` in a single pass over
    the message list — no double-redact on the hot path.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from services.litellm_redactor.redaction import redact_messages_with_counts

log = logging.getLogger("litellm.redactor")

_SAMPLE_EVERY = max(1, int(os.getenv("LITELLM_REDACTION_LOG_SAMPLE", "1") or "1"))
_call_count = 0


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

    # Single pass — produces both the redacted wire payload and the
    # per-kind counts so we don't re-run the regex engine on every
    # message just to log the totals.
    redacted, counts = redact_messages_with_counts(messages)
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
