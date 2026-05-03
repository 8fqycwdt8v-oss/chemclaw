"""Deterministic cache-key derivation for QM jobs.

Every xTB / CREST / sTDA-xTB / IPEA-xTB / g-xTB invocation MUST go through
`qm_cache_key(...)` so repeat calls short-circuit to the cached `qm_jobs` row
(see `db/init/23_qm_results.sql`). The key is a 32-byte SHA-256 over the
canonical method + input + parameters tuple.

Canonicalization rules:
- `method` and `task` are uppercased.
- `smiles_canonical` is passed in already canonical (RDKit MolToSmiles after
  MolFromSmiles); the caller is responsible.
- `solvent_model` is lowercased; `solvent_name` is left as-is (case may
  matter — `DMSO` vs `dmso` may map to different parameter sets in practice).
- `params` is dumped via `json.dumps(..., sort_keys=True, separators=(",", ":"))`
  so dict ordering doesn't perturb the hash.

Two callers of this module:
- Python MCP services (mcp_xtb / mcp_crest) — Phase 2.
- The TypeScript agent's `qm-cache.ts` client uses an identical formulation
  so a hit computed in TS matches a row written by Python. Cross-language
  parity is asserted by `tests/integration/test_qm_hash_pact.py`.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


_CACHE_KEY_VERSION = "1"  # bump if the canonicalization rules change


def qm_cache_key(
    *,
    method: str,
    task: str,
    smiles_canonical: str,
    charge: int = 0,
    multiplicity: int = 1,
    solvent_model: str | None = None,
    solvent_name: str | None = None,
    params: dict[str, Any] | None = None,
) -> bytes:
    """Return the 32-byte SHA-256 cache key for a QM invocation.

    Inputs are normalized then concatenated with the version prefix so a
    future canonicalization change cannot collide with prior cache entries.
    """
    if not method or not task:
        raise ValueError("method and task are required")
    if not smiles_canonical or not smiles_canonical.strip():
        raise ValueError("smiles_canonical must be non-empty")
    if multiplicity < 1:
        raise ValueError("multiplicity must be >= 1")

    canonical_params = json.dumps(params or {}, sort_keys=True, separators=(",", ":"))
    parts = [
        _CACHE_KEY_VERSION,
        method.upper(),
        task.upper(),
        smiles_canonical,
        str(int(charge)),
        str(int(multiplicity)),
        (solvent_model or "none").lower(),
        solvent_name or "",
        canonical_params,
    ]
    blob = "|".join(parts).encode("utf-8")
    return hashlib.sha256(blob).digest()


def qm_cache_key_hex(
    *,
    method: str,
    task: str,
    smiles_canonical: str,
    charge: int = 0,
    multiplicity: int = 1,
    solvent_model: str | None = None,
    solvent_name: str | None = None,
    params: dict[str, Any] | None = None,
) -> str:
    """Same as `qm_cache_key`, but returns the lowercase hex digest.

    Useful for log lines and error messages where binary keys would render
    as garbage; never used for the actual DB lookup (which compares BYTEA).
    """
    return qm_cache_key(
        method=method,
        task=task,
        smiles_canonical=smiles_canonical,
        charge=charge,
        multiplicity=multiplicity,
        solvent_model=solvent_model,
        solvent_name=solvent_name,
        params=params,
    ).hex()
