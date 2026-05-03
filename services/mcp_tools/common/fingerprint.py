"""Shared bit-to-vector encoding used by the projector + any service that
needs to write a binary fingerprint into a pgvector column.

The TypeScript mirror lives in services/agent-claw/src/db/qm-cache.ts
(`onBitsToPgvectorLiteral`) plus the inline copy in find_similar_compounds.ts.
A future task is to extract the TS version too.
"""

from __future__ import annotations


def bits_to_pgvector_literal(on_bits: list[int], n_bits: int) -> str:
    """Encode a sparse on-bits list as the pgvector literal string '[0,1,0,...]'.

    Out-of-range bits are silently dropped, mirroring the TS implementation.
    """
    if n_bits <= 0:
        raise ValueError("n_bits must be positive")
    bits = [0] * n_bits
    for b in on_bits:
        if 0 <= b < n_bits:
            bits[b] = 1
    return "[" + ",".join(str(b) for b in bits) + "]"
