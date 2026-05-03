"""Phase 5 hardening — fragment_link must use proper SMILES assembly.

The previous implementation concatenated raw SMILES strings, which silently
produced wrong molecules. The hardened version requires [*] dummy atoms on
both fragments and a bivalent linker, then uses RDKit's CombineMols + RWMol
to add real bonds.
"""

from __future__ import annotations

import pytest


def test_assemble_via_dummy_atoms_simple():
    from rdkit import Chem
    from services.mcp_tools.mcp_genchem.main import _assemble_via_dummy_atoms

    # Phenyl-[*] + [*]-CH2-[*] + [*]-Phenyl → diphenylmethane (CC1=CC=CC=C1Cc2ccccc2)
    new = _assemble_via_dummy_atoms("c1ccccc1[*]", "[*]C[*]", "[*]c1ccccc1")
    assert new is not None
    smi = Chem.MolToSmiles(new)
    # diphenylmethane canonical SMILES
    assert smi == "c1ccc(Cc2ccccc2)cc1"


def test_assemble_rejects_linker_with_wrong_dummy_count():
    from services.mcp_tools.mcp_genchem.main import _assemble_via_dummy_atoms
    # Linker has only one [*] — cannot bridge two fragments.
    new = _assemble_via_dummy_atoms("c1ccccc1[*]", "[*]C", "[*]c1ccccc1")
    assert new is None


def test_assemble_rejects_invalid_smiles():
    from services.mcp_tools.mcp_genchem.main import _assemble_via_dummy_atoms
    new = _assemble_via_dummy_atoms("not-smiles", "[*]C[*]", "[*]c1ccccc1")
    assert new is None


def test_fragment_link_route_validates_dummies(monkeypatch):
    """When fragments lack [*] markers, the endpoint raises 400."""
    monkeypatch.setenv("MCP_AUTH_DEV_MODE", "true")
    monkeypatch.setattr(
        "services.mcp_tools.common.scopes.SERVICE_SCOPES",
        {"mcp-genchem": "mcp_genchem:invoke"},
        raising=False,
    )
    monkeypatch.setattr(
        "services.mcp_tools.mcp_genchem.main._record_run", lambda **kw: "stub-run-id",
    )

    from fastapi.testclient import TestClient
    from services.mcp_tools.mcp_genchem.main import app

    with TestClient(app) as client:
        r = client.post(
            "/fragment_link",
            json={
                "fragment_a_smiles": "c1ccccc1",   # no [*]
                "fragment_b_smiles": "c1ccccc1",
                "linkers": ["[*]C[*]"],
            },
        )
        assert r.status_code == 400
        assert "dummy" in r.json()["detail"].lower()


def test_fragment_link_assembles_diphenylmethane(monkeypatch):
    monkeypatch.setenv("MCP_AUTH_DEV_MODE", "true")
    monkeypatch.setattr(
        "services.mcp_tools.common.scopes.SERVICE_SCOPES",
        {"mcp-genchem": "mcp_genchem:invoke"},
        raising=False,
    )
    monkeypatch.setattr(
        "services.mcp_tools.mcp_genchem.main._record_run", lambda **kw: "stub-run-id",
    )

    from fastapi.testclient import TestClient
    from services.mcp_tools.mcp_genchem.main import app

    with TestClient(app) as client:
        r = client.post(
            "/fragment_link",
            json={
                "fragment_a_smiles": "c1ccccc1[*]",
                "fragment_b_smiles": "[*]c1ccccc1",
                "linkers": ["[*]C[*]"],
                "max_proposals": 5,
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        smis = {p["smiles"] for p in body["proposals"]}
        assert "c1ccc(Cc2ccccc2)cc1" in smis
