"""Langfuse trace + feedback fetcher for GEPA runner.

Uses the Langfuse Python SDK to pull:
  - traces for a given prompt name in a 24-hour window
  - feedback scores attached to those traces

All calls are thin wrappers so they can be trivially mocked in tests.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any

# Lazy import so tests can mock without installing langfuse.
try:
    from langfuse import Langfuse
    _HAS_LANGFUSE = True
except ImportError:
    _HAS_LANGFUSE = False


# ---------------------------------------------------------------------------
# Thin client
# ---------------------------------------------------------------------------

class LangfuseTraceClient:
    """Minimal Langfuse trace-fetch client.

    In production, LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY
    must be set.  In tests, pass a mock_client.
    """

    def __init__(
        self,
        host: str | None = None,
        public_key: str | None = None,
        secret_key: str | None = None,
        *,
        mock_client: Any = None,
    ) -> None:
        if mock_client is not None:
            self._client = mock_client
        elif _HAS_LANGFUSE:
            self._client = Langfuse(
                host=host or os.environ.get("LANGFUSE_HOST", "http://localhost:3000"),
                public_key=public_key or os.environ.get("LANGFUSE_PUBLIC_KEY", ""),
                secret_key=secret_key or os.environ.get("LANGFUSE_SECRET_KEY", ""),
            )
        else:
            raise ImportError("langfuse not installed; install it or pass a mock_client")

    def fetch_traces_for_prompt(
        self,
        prompt_name: str,
        hours: int = 24,
    ) -> list[dict[str, Any]]:
        """Return a list of trace dicts for `prompt_name` in the last `hours` hours."""
        since = datetime.now(tz=timezone.utc) - timedelta(hours=hours)

        # Langfuse SDK: fetch_traces returns a FetchTracesResponse with .data
        resp = self._client.fetch_traces(
            tags=[f"prompt:{prompt_name}"],
            from_timestamp=since,
        )
        traces = getattr(resp, "data", resp) or []
        return [self._to_dict(t) for t in traces]

    def fetch_scores_for_trace(self, trace_id: str) -> list[dict[str, Any]]:
        """Return score dicts attached to a trace."""
        resp = self._client.fetch_scores(trace_id=trace_id)
        scores = getattr(resp, "data", resp) or []
        return [self._to_dict(s) for s in scores]

    @staticmethod
    def _to_dict(obj: Any) -> dict[str, Any]:
        if isinstance(obj, dict):
            return obj
        # Langfuse SDK objects expose __dict__ or model_dump.
        if hasattr(obj, "model_dump"):
            return obj.model_dump()
        return vars(obj)
