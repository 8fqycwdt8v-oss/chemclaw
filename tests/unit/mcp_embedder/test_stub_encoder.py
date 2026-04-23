"""Unit tests for the stub encoder.

The stub is dev-only but these tests lock down its contracts: determinism
and normalisation. We don't test BGEM3Encoder here (it requires a multi-GB
model download); that's an integration test gated behind an env var.
"""

from __future__ import annotations

import math

from services.mcp_tools.mcp_embedder.encoder import StubEncoder


def test_dim_matches_configured() -> None:
    enc = StubEncoder(dim=64)
    out = enc.encode(["foo"], normalize=True)
    assert len(out) == 1
    assert len(out[0]) == 64


def test_deterministic_for_same_input() -> None:
    enc = StubEncoder(dim=32)
    a = enc.encode(["same text"], normalize=True)[0]
    b = enc.encode(["same text"], normalize=True)[0]
    assert a == b


def test_different_inputs_differ() -> None:
    enc = StubEncoder(dim=64)
    a = enc.encode(["alpha"], normalize=True)[0]
    b = enc.encode(["beta"], normalize=True)[0]
    assert a != b


def test_normalize_produces_unit_vectors() -> None:
    enc = StubEncoder(dim=32)
    v = enc.encode(["something"], normalize=True)[0]
    norm = math.sqrt(sum(x * x for x in v))
    assert abs(norm - 1.0) < 1e-5


def test_no_normalize_allowed() -> None:
    enc = StubEncoder(dim=32)
    v = enc.encode(["something"], normalize=False)[0]
    # Non-normalised gaussian draw — norm is unlikely to be exactly 1.
    norm = math.sqrt(sum(x * x for x in v))
    assert abs(norm - 1.0) > 1e-5
