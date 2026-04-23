"""SSE client for the agent's /api/chat endpoint.

Parses the `text/event-stream` response line-by-line and yields typed
StreamEvent dicts. Designed for Streamlit's `st.write_stream` consumption:
when the caller wants a pure text stream, they can filter for `text_delta`
events; tool-call events are handled out-of-band by the UI.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import httpx

from services.frontend.settings import get_settings


class ChatClientError(RuntimeError):
    pass


def _iter_sse_events(resp: httpx.Response) -> Iterator[dict[str, Any]]:
    """Yield parsed JSON payloads from a `data: ...` SSE stream.

    Malformed frames are silently skipped — the server is trusted but we
    never pass raw bytes to `json.loads` without a sanity guard.
    """
    import json

    buffer = ""
    for raw in resp.iter_lines():
        if not raw:
            # Frame boundary — flush buffer.
            if buffer:
                _try_emit(buffer, out := [])
                yield from out
                buffer = ""
            continue
        if raw.startswith(":"):
            # SSE comment — keepalive.
            continue
        if raw.startswith("data: "):
            buffer += raw[len("data: "):]
    if buffer:
        out: list[dict[str, Any]] = []
        _try_emit(buffer, out)
        yield from out


def _try_emit(data: str, out: list[dict[str, Any]]) -> None:
    import json

    try:
        payload = json.loads(data)
    except json.JSONDecodeError:
        return
    if isinstance(payload, dict):
        out.append(payload)


def stream_chat(
    user_email: str,
    messages: list[dict[str, str]],
    *,
    timeout_s: float = 120.0,
) -> Iterator[dict[str, Any]]:
    """POST /api/chat with streaming; yield each StreamEvent dict.

    The caller is responsible for filtering events by `type` and updating the
    UI accordingly. We do not interpret text content — that's the UI's job.
    """
    settings = get_settings()
    url = f"{settings.agent_base_url}/api/chat"
    body = {"messages": messages, "stream": True}

    headers = {"Accept": "text/event-stream", "X-Forwarded-User": user_email}

    with httpx.Client(timeout=timeout_s) as client:
        with client.stream("POST", url, json=body, headers=headers) as resp:
            if resp.status_code >= 400:
                # Read error body (bounded) to surface a diagnostic.
                snippet = resp.read().decode("utf-8", errors="replace")[:500]
                raise ChatClientError(f"agent returned {resp.status_code}: {snippet}")
            yield from _iter_sse_events(resp)
