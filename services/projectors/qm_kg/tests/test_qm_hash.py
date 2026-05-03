"""Tests for the deterministic QM cache-key helper."""

from __future__ import annotations

from services.mcp_tools.common.qm_hash import qm_cache_key, qm_cache_key_hex


def test_cache_key_is_32_bytes() -> None:
    key = qm_cache_key(method="GFN2", task="opt", smiles_canonical="CCO")
    assert isinstance(key, bytes)
    assert len(key) == 32


def test_cache_key_is_deterministic() -> None:
    a = qm_cache_key(method="GFN2", task="opt", smiles_canonical="CCO", charge=0)
    b = qm_cache_key(method="GFN2", task="opt", smiles_canonical="CCO", charge=0)
    assert a == b


def test_cache_key_differs_on_method() -> None:
    a = qm_cache_key(method="GFN2", task="opt", smiles_canonical="CCO")
    b = qm_cache_key(method="g-xTB", task="opt", smiles_canonical="CCO")
    assert a != b


def test_cache_key_differs_on_task() -> None:
    a = qm_cache_key(method="GFN2", task="opt", smiles_canonical="CCO")
    b = qm_cache_key(method="GFN2", task="freq", smiles_canonical="CCO")
    assert a != b


def test_cache_key_param_order_independent() -> None:
    a = qm_cache_key(
        method="GFN2",
        task="opt",
        smiles_canonical="CCO",
        params={"a": 1, "b": 2, "c": 3},
    )
    b = qm_cache_key(
        method="GFN2",
        task="opt",
        smiles_canonical="CCO",
        params={"c": 3, "b": 2, "a": 1},
    )
    assert a == b


def test_cache_key_method_case_insensitive() -> None:
    a = qm_cache_key(method="gfn2", task="opt", smiles_canonical="CCO")
    b = qm_cache_key(method="GFN2", task="OPT", smiles_canonical="CCO")
    assert a == b


def test_cache_key_solvent_model_lowercased() -> None:
    a = qm_cache_key(
        method="GFN2", task="opt", smiles_canonical="CCO", solvent_model="alpb",
    )
    b = qm_cache_key(
        method="GFN2", task="opt", smiles_canonical="CCO", solvent_model="ALPB",
    )
    assert a == b


def test_cache_key_solvent_name_case_sensitive() -> None:
    # Solvent names may map to different parameter sets in some xtb builds.
    a = qm_cache_key(
        method="GFN2", task="opt", smiles_canonical="CCO",
        solvent_model="alpb", solvent_name="DMSO",
    )
    b = qm_cache_key(
        method="GFN2", task="opt", smiles_canonical="CCO",
        solvent_model="alpb", solvent_name="dmso",
    )
    assert a != b


def test_cache_key_hex_returns_64_chars() -> None:
    h = qm_cache_key_hex(method="GFN2", task="opt", smiles_canonical="CCO")
    assert isinstance(h, str)
    assert len(h) == 64
    assert all(c in "0123456789abcdef" for c in h)


def test_cache_key_validates_inputs() -> None:
    import pytest
    with pytest.raises(ValueError):
        qm_cache_key(method="", task="opt", smiles_canonical="CCO")
    with pytest.raises(ValueError):
        qm_cache_key(method="GFN2", task="", smiles_canonical="CCO")
    with pytest.raises(ValueError):
        qm_cache_key(method="GFN2", task="opt", smiles_canonical="")
    with pytest.raises(ValueError):
        qm_cache_key(method="GFN2", task="opt", smiles_canonical="CCO", multiplicity=0)
