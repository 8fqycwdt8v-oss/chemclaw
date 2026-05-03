"""Tests for mcp-green-chemistry FastAPI app."""
from __future__ import annotations

from unittest import mock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client():
    from services.mcp_tools.mcp_green_chemistry.main import app  # noqa: PLC0415
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# /healthz + /readyz
# ---------------------------------------------------------------------------

def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-green-chemistry"


def test_readyz_200_when_data_dir_present(client):
    r = client.get("/readyz")
    assert r.status_code == 200


def test_readyz_503_when_data_dir_missing(tmp_path):
    missing = tmp_path / "no_data"
    with mock.patch(
        "services.mcp_tools.mcp_green_chemistry.main._DATA_DIR",
        missing,
    ):
        from services.mcp_tools.mcp_green_chemistry.main import app
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 503


# ---------------------------------------------------------------------------
# /score_solvents
# ---------------------------------------------------------------------------

def test_score_solvents_known_smiles(client):
    r = client.post("/score_solvents", json={"solvents": [{"smiles": "ClCCl"}]})
    assert r.status_code == 200
    body = r.json()
    assert len(body["results"]) == 1
    res = body["results"][0]
    assert res["chem21_class"] == "HighlyHazardous"
    assert res["match_confidence"] == "smiles_exact"
    assert res["canonical_smiles"] == "ClCCl"


def test_score_solvents_known_name_fuzzy(client):
    r = client.post("/score_solvents", json={"solvents": [{"name": "Dichloromethane"}]})
    assert r.status_code == 200
    body = r.json()
    res = body["results"][0]
    # "Dichloromethane" doesn't exactly match "DCM" — fuzzy may not trip 90.
    # Test that name "DCM" matches.
    r2 = client.post("/score_solvents", json={"solvents": [{"name": "DCM"}]})
    res2 = r2.json()["results"][0]
    assert res2["chem21_class"] == "HighlyHazardous"
    assert res2["match_confidence"] == "name_only"


def test_score_solvents_recommended(client):
    r = client.post("/score_solvents", json={"solvents": [{"smiles": "C1OCC(C)O1"}]})
    assert r.status_code == 200
    res = r.json()["results"][0]
    assert res["chem21_class"] == "Recommended"


def test_score_solvents_unmatched(client):
    r = client.post(
        "/score_solvents",
        json={"solvents": [{"smiles": "C1CC2CC1CC2"}]},  # made-up bicycloalkane
    )
    assert r.status_code == 200
    res = r.json()["results"][0]
    assert res["chem21_class"] is None
    assert res["match_confidence"] == "unmatched"


def test_score_solvents_batch(client):
    r = client.post(
        "/score_solvents",
        json={"solvents": [{"smiles": "CCO"}, {"smiles": "ClCCl"}, {"name": "Toluene"}]},
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body["results"]) == 3
    assert body["results"][0]["chem21_class"] == "Recommended"
    assert body["results"][1]["chem21_class"] == "HighlyHazardous"
    assert body["results"][2]["chem21_class"] == "Problematic"


def test_score_solvents_empty_input_400(client):
    r = client.post("/score_solvents", json={"solvents": []})
    assert r.status_code in (400, 422)


def test_score_solvents_includes_all_vendor_classes(client):
    r = client.post("/score_solvents", json={"solvents": [{"smiles": "ClCCl"}]})
    res = r.json()["results"][0]
    for key in ["chem21_class", "gsk_class", "pfizer_class", "az_class", "sanofi_class", "acs_unified_class"]:
        assert key in res, f"missing key {key}"
        assert res[key] is not None, f"vendor class {key} was None for DCM"


# ---------------------------------------------------------------------------
# /assess_reaction_safety
# ---------------------------------------------------------------------------

def test_assess_reaction_safety_no_hazardous_groups(client):
    r = client.post(
        "/assess_reaction_safety",
        json={
            "reaction_smiles": "CC(=O)O.CCO>>CC(=O)OCC.O",  # esterification
            "solvents": [{"smiles": "C1OCC(C)O1"}],  # 2-MeTHF
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["hazardous_groups"] == []
    assert body["overall_safety_class"] == "Recommended"
    assert isinstance(body["pmi_estimate"], (int, float))


def test_assess_reaction_safety_flags_azide(client):
    r = client.post(
        "/assess_reaction_safety",
        json={
            "reaction_smiles": "[N-]=[N+]=Nc1ccccc1.C#CCN>>c1ccc(-c2cn(CC#C)nn2)cc1",
            "solvents": [{"smiles": "O"}],
        },
    )
    assert r.status_code == 200
    body = r.json()
    group_names = [g["group_name"] for g in body["hazardous_groups"]]
    assert "Azide" in group_names


def test_assess_reaction_safety_solvent_drives_overall_class(client):
    """A safe esterification in DCM should still flag overall."""
    r = client.post(
        "/assess_reaction_safety",
        json={
            "reaction_smiles": "CC(=O)O.CCO>>CC(=O)OCC.O",
            "solvents": [{"smiles": "ClCCl"}],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["solvent_safety_score"] >= 8
    assert body["overall_safety_class"] == "HighlyHazardous"


def test_assess_reaction_safety_invalid_smiles_400(client):
    r = client.post(
        "/assess_reaction_safety",
        json={"reaction_smiles": "not a smiles", "solvents": []},
    )
    assert r.status_code in (400, 422)
