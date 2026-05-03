"""In-memory LRU cache of fitted per-project XGBoost models.

Cap 32 projects, 30-min TTL. Cache key: project-prefixed sha256 of sorted
training_pairs. Same data → same key → cache hit. On capacity overflow,
evict by oldest expires_at.
"""
from __future__ import annotations

import hashlib
import json
import time
from typing import Any

_TTL_SEC = 30 * 60
_CAP = 32

_CACHE: dict[str, dict[str, Any]] = {}


def deterministic_id(project_internal_id: str, training_pairs: list[dict[str, Any]]) -> str:
    """Return a stable id from sorted pair contents."""
    h = hashlib.sha256()
    h.update(project_internal_id.encode("utf-8"))
    sorted_pairs = sorted(
        training_pairs, key=lambda p: (p["rxn_smiles"], p["yield_pct"])
    )
    h.update(json.dumps(sorted_pairs, sort_keys=True).encode("utf-8"))
    return f"{project_internal_id}@{h.hexdigest()[:16]}"


def store(model_id: str, model: Any) -> None:
    _evict()
    _CACHE[model_id] = {"model": model, "expires_at": time.time() + _TTL_SEC}


def get(model_id: str) -> Any | None:
    _evict()
    entry = _CACHE.get(model_id)
    return entry["model"] if entry is not None else None


def _evict() -> None:
    """Drop expired entries; if still over cap, drop oldest."""
    now = time.time()
    expired = [k for k, v in _CACHE.items() if v["expires_at"] < now]
    for k in expired:
        del _CACHE[k]
    while len(_CACHE) > _CAP:
        oldest = min(_CACHE, key=lambda k: _CACHE[k]["expires_at"])
        del _CACHE[oldest]


def clear() -> None:
    """Reset cache state — used by tests between cases."""
    _CACHE.clear()
