"""Smoke tests for mcp-genchem — RDKit-only paths, no DB."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("MCP_AUTH_DEV_MODE", "true")
    monkeypatch.setattr(
        "services.mcp_tools.common.scopes.SERVICE_SCOPES",
        {"mcp-genchem": "mcp_genchem:invoke"},
        raising=False,
    )
    from services.mcp_tools.mcp_genchem.main import app

    with TestClient(app) as c:
        yield c


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200


def test_attachment_helpers():
    from services.mcp_tools.mcp_genchem.main import (
        _attach_rgroups, _attachment_labels, _has_attachment_points, _mol,
    )
    scaffold = _mol("c1ccccc1[*:1]")
    assert _has_attachment_points(scaffold)
    assert _attachment_labels(scaffold) == {"1"}
    new = _attach_rgroups("c1ccccc1[*:1]", ["1"], ("F",))
    from rdkit import Chem
    assert Chem.MolToSmiles(new) == "Fc1ccccc1"


def test_scaffold_decorate_returns_proposals(client, monkeypatch):
    # Stub the persistence helper so the test doesn't need a live DB.
    monkeypatch.setattr(
        "services.mcp_tools.mcp_genchem.main._record_run",
        lambda **kw: "stub-run-id",
    )
    r = client.post(
        "/scaffold_decorate",
        json={
            "scaffold_smiles": "c1ccccc1[*:1]",
            "rgroups": {"1": ["F", "Cl", "OC", "C(F)(F)F"]},
            "rgroup_library": "custom",
            "max_proposals": 10,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "scaffold"
    smis = {p["smiles"] for p in body["proposals"]}
    # All four R-groups should produce a unique benzene-monosubstitution.
    assert len(smis) >= 3


def test_fragment_link_assembles(client, monkeypatch):
    monkeypatch.setattr(
        "services.mcp_tools.mcp_genchem.main._record_run",
        lambda **kw: "stub-run-id",
    )
    r = client.post(
        "/fragment_link",
        json={
            "fragment_a_smiles": "c1ccccc1",
            "fragment_b_smiles": "c1ccccc1",
            "linkers": ["", "C", "CC", "OC"],
            "max_proposals": 10,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "link"
    assert body["n_proposed"] >= 1


def test_reinvent_returns_501(client):
    r = client.post("/reinvent_run", json={})
    assert r.status_code == 501
    assert r.json()["error"] == "not_implemented"
