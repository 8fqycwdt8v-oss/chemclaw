"""Defensive caps on opaque JSONB pass-through.

Both ``mcp_eln_local`` (``fields_jsonb``) and ``mcp_logs_sciy``
(``parameters_jsonb``, ``peaks_jsonb``) return JSONB blobs verbatim from
Postgres rows into the agent's response. A pathological row — or, when
the LOGS ``real`` backend lands, a real LOGS dataset with thousands of
peaks — could blow the agent's token budget on a single fetch and trip
the ``compact-window`` hook on every turn.

This module caps each blob to a fixed byte budget. When the JSON-encoded
size exceeds the cap, the original is replaced with a small dict that
documents the truncation and includes a UTF-8 string preview, so callers
can detect the situation programmatically and the agent's response still
contains a useful breadcrumb instead of an opaque stub.
"""

from __future__ import annotations

import json
from typing import Any


# 64 KiB per JSONB field. A single research turn has tens of thousands
# of tokens to spend; any single field consuming more than ~16k tokens
# (~64 KB) is almost certainly noise, not signal.
DEFAULT_JSONB_CAP_BYTES = 64 * 1024

# Preview length for truncated payloads — long enough to surface the
# top-level keys / the first few entries, short enough that the
# truncation marker itself doesn't blow the budget.
_PREVIEW_CHARS = 500


def cap_jsonb(
    value: Any,
    *,
    cap_bytes: int = DEFAULT_JSONB_CAP_BYTES,
    field_name: str = "value",
) -> Any:
    """Return ``value`` if its JSON encoding fits under ``cap_bytes``,
    otherwise a truncation-marker dict.

    The returned marker is shaped:
        {
          "_truncated": true,
          "_field": "<name>",
          "_original_size_bytes": <int>,
          "_limit_bytes": <int>,
          "_preview": "<first PREVIEW_CHARS chars of json.dumps(value)>"
        }

    Callers downstream — particularly the agent and the source-cache
    hook — can detect the marker via the ``_truncated`` key and decide
    whether to escalate (e.g. fetch the full payload via a follow-up
    targeted call).
    """
    if value is None:
        return value
    try:
        encoded = json.dumps(value, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        # Unencodable input — return a marker rather than 500-ing the
        # whole request; the field becomes evidently bad to the agent.
        return {
            "_truncated": True,
            "_field": field_name,
            "_original_size_bytes": -1,
            "_limit_bytes": cap_bytes,
            "_preview": f"<unencodable {type(value).__name__}>",
        }
    size = len(encoded.encode("utf-8"))
    if size <= cap_bytes:
        return value
    preview = encoded[:_PREVIEW_CHARS]
    return {
        "_truncated": True,
        "_field": field_name,
        "_original_size_bytes": size,
        "_limit_bytes": cap_bytes,
        "_preview": preview,
    }
