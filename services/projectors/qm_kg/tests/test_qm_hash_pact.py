"""Cross-language pact test: Python qm_hash matches the TS computeQmCacheKey.

The Python and TypeScript sides MUST produce identical 32-byte cache keys
for the same input or the QM cache is silently double-allocating storage.

Strategy: compute Python's hex digest for a fixed input grid here. The
TypeScript side's `tests/unit/qm-cache-pact.test.ts` (sibling) generates the
same grid and compares against this file's published hex values. If either
side's canonicalization changes, both sides must bump _CACHE_KEY_VERSION.
"""

from __future__ import annotations

import json
from pathlib import Path

from services.mcp_tools.common.qm_hash import qm_cache_key_hex


# Fixed grid of inputs. ANY change here is a load-bearing pact change.
PARITY_VECTORS = [
    {"method": "GFN2", "task": "opt", "smiles_canonical": "CCO"},
    {"method": "GFN2", "task": "freq", "smiles_canonical": "CCO"},
    {"method": "g-xTB", "task": "sp", "smiles_canonical": "c1ccccc1"},
    {"method": "GFN-FF", "task": "opt", "smiles_canonical": "CCO", "charge": -1, "multiplicity": 2},
    {"method": "CREST", "task": "conformers", "smiles_canonical": "CCO",
     "solvent_model": "alpb", "solvent_name": "water",
     "params": {"n_max": 20}},
    {"method": "IPEA-xTB", "task": "redox", "smiles_canonical": "C1=CC=CC=C1",
     "solvent_model": "alpb", "solvent_name": "water",
     "params": {"electrons": 1, "reference": "SHE"}},
]


def test_parity_vectors_emit_64_hex_chars():
    for v in PARITY_VECTORS:
        h = qm_cache_key_hex(**v)
        assert isinstance(h, str)
        assert len(h) == 64
        assert all(c in "0123456789abcdef" for c in h)


def test_parity_vectors_are_distinct():
    seen = {qm_cache_key_hex(**v) for v in PARITY_VECTORS}
    assert len(seen) == len(PARITY_VECTORS), "two inputs collided in cache key"


def test_parity_vectors_dump_for_ts_pact(tmp_path: Path):
    # Emit the Python-side grid to a known file so the TS pact test can
    # consume it. Each line is `<hex>\t<json input>`. The TS test reads it,
    # runs computeQmCacheKey on the same input, and asserts equality.
    fixture_dir = Path(__file__).resolve().parents[3] / "agent-claw" / "tests" / "fixtures"
    fixture_dir.mkdir(parents=True, exist_ok=True)
    out = fixture_dir / "qm_hash_parity_vectors.tsv"
    lines = []
    for v in PARITY_VECTORS:
        h = qm_cache_key_hex(**v)
        lines.append(f"{h}\t{json.dumps(v, sort_keys=True)}")
    out.write_text("\n".join(lines) + "\n")
    assert out.exists()
    assert out.stat().st_size > 0
