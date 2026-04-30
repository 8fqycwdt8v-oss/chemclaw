"""Shared helpers for the mcp-synthegy-mech service.

Anything reused by more than one of {main, llm_policy, mechanism_search,
xtb_validator, move_diff, tests/} lives here. Keep this module small and
dependency-light — no rdkit imports here, no FastAPI imports.
"""
from __future__ import annotations

import hashlib


def smiles_tag(smiles: str) -> str:
    """Stable, non-reversible identifier for a SMILES, safe to log.

    Proprietary compound structures must not appear in production logs even
    truncated — 80 chars is enough to identify most NCEs by structure search.
    A short blake2s digest is sufficient to correlate log lines for the same
    intermediate without revealing the structure itself.

    Single source of truth: previously this helper was defined three times
    (llm_policy._smiles_tag, xtb_validator._smiles_tag,
    mechanism_search._hash_for_log) with byte-for-byte identical bodies.
    Centralizing here so a future change (e.g. raising digest_size for
    collision resistance) propagates to all callers automatically.
    """
    return hashlib.blake2s(smiles.encode("utf-8"), digest_size=8).hexdigest()
