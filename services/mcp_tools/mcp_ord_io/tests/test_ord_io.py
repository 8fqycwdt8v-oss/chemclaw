"""Tests for mcp-ord-io export/import round-trip."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client():
    from services.mcp_tools.mcp_ord_io.main import app  # noqa: PLC0415
    with TestClient(app) as c:
        yield c


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-ord-io"


def test_readyz(client):
    r = client.get("/readyz")
    assert r.status_code == 200


def test_export_round_trips_through_import(client):
    plate_payload = {
        "plate_name": "test-plate",
        "reactants_smiles": "CC.OO",
        "product_smiles": "CC(=O)O",
        "wells": [
            {
                "well_id": "A01",
                "rxn_smiles": "CC.OO>>CC(=O)O",
                "factor_values": {"temperature_c": 80.0, "solvent": "EtOH"},
            },
            {
                "well_id": "A02",
                "rxn_smiles": "CC.OO>>CC(=O)O",
                "factor_values": {"temperature_c": 100.0, "solvent": "Toluene"},
            },
        ],
    }
    r = client.post("/export", json=plate_payload)
    assert r.status_code == 200, r.text
    export = r.json()
    assert export["n_reactions"] == 2

    r2 = client.post(
        "/import",
        json={"ord_protobuf_b64": export["ord_protobuf_b64"]},
    )
    assert r2.status_code == 200, r2.text
    out = r2.json()
    assert out["plate_name"] == "test-plate"
    assert out["n_reactions"] == 2
    assert out["reactions"][0]["rxn_smiles"] == "CC.OO>>CC(=O)O"
    assert out["reactions"][0]["temperature_c"] == 80.0


def test_import_invalid_base64(client):
    r = client.post("/import", json={"ord_protobuf_b64": "!!!not-base64!!!"})
    assert r.status_code == 400
    assert "invalid_base64" in r.json().get("detail", "")


def test_export_empty_wells_rejected(client):
    r = client.post("/export", json={"plate_name": "x", "wells": []})
    assert r.status_code in (400, 422)
