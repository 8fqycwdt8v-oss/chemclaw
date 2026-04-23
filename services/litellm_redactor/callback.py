"""LiteLLM pre_api_call callback that redacts messages before egress.

LiteLLM will call this function with kwargs that include 'messages'. We
mutate `messages` in place (LiteLLM's convention) and log a tiny
metrics line for observability.
"""

from __future__ import annotations

import logging
from typing import Any

from services.litellm_redactor.redaction import redact_messages

log = logging.getLogger("litellm.redactor")


async def redactor_callback(
    kwargs: dict[str, Any],
    completion_response: Any | None = None,  # noqa: ARG001
    start_time: Any | None = None,            # noqa: ARG001
    end_time: Any | None = None,              # noqa: ARG001
) -> None:
    messages = kwargs.get("messages")
    if not messages:
        return
    redacted = redact_messages(messages)
    # LiteLLM mutates on kwargs — replace in-place.
    kwargs["messages"] = redacted
    # Count-only log (we never log the values).
    log.info(
        "redacted call model=%s messages=%d",
        kwargs.get("model", "?"),
        len(messages),
    )
