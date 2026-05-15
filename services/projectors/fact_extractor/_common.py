"""Shared helpers for per-source extractors.

Pure functions only — no DB, no logging side-effects beyond debug. Kept
small so each extractor module can be read top-to-bottom in one screen.
"""
from __future__ import annotations

from typing import Any


def confidence_tier(score: float) -> str:
    """Map a numeric confidence to the canonical tier label used in
    facts.confidence_tier."""
    if score >= 0.85:
        return "high"
    if score >= 0.65:
        return "medium"
    if score >= 0.40:
        return "low"
    return "exploratory"


def resolve_smiles(
    result: dict[str, Any],
    args: dict[str, Any],
    *,
    response_keys: tuple[str, ...] = ("smiles_canonical", "smiles"),
    args_keys: tuple[str, ...] = ("smiles",),
) -> str | None:
    """Find a SMILES identifier in the response (canonical preferred)
    then the args, then None. Caller is responsible for handling None
    by returning an empty fact list."""
    for k in response_keys:
        v = result.get(k)
        if isinstance(v, str) and v:
            return v
    for k in args_keys:
        v = args.get(k)
        if isinstance(v, str) and v:
            return v
    return None
