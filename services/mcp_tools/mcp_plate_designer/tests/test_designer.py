"""Tests for the plate-designer pure-function module + endpoint."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from services.mcp_tools.mcp_plate_designer import designer as _designer

_DATA_DIR = Path(__file__).resolve().parents[1] / "data"
_CHEM21 = _designer.load_chem21_floor(_DATA_DIR)


@pytest.fixture()
def client():
    from services.mcp_tools.mcp_plate_designer.main import app  # noqa: PLC0415
    with TestClient(app) as c:
        yield c


def test_plate_geometry():
    assert _designer.plate_geometry("24") == (4, 6)
    assert _designer.plate_geometry("96") == (8, 12)
    assert _designer.plate_geometry("384") == (16, 24)
    assert _designer.plate_geometry("1536") == (32, 48)


def test_well_id_format():
    assert _designer.well_id(0, 0) == "A01"
    assert _designer.well_id(7, 11) == "H12"
    assert _designer.well_id(15, 23) == "P24"


def test_generate_well_ids_96():
    ids = _designer.generate_well_ids("96", 96)
    assert ids[0] == "A01"
    assert ids[-1] == "H12"
    assert len(ids) == 96


def test_chem21_floor_loads():
    floor = _designer.load_chem21_floor(_DATA_DIR)
    assert "DCM" in floor
    assert "DMF" in floor
    assert "Hexane" in floor
    assert "Ethanol" not in floor  # Recommended


def test_apply_exclusions_drops_user_exclusion():
    cats, _ = _designer.apply_exclusions(
        categorical_inputs=[{"name": "solvent", "values": ["EtOH", "DCM", "Toluene"]}],
        exclusions={"solvents": ["DCM"]},
        chem21_floor=set(),
    )
    assert cats[0]["values"] == ["EtOH", "Toluene"]


def test_apply_exclusions_chem21_floor_drops_dcm_even_without_explicit_exclusion():
    cats, applied = _designer.apply_exclusions(
        categorical_inputs=[{"name": "solvent", "values": ["EtOH", "DCM", "Toluene"]}],
        exclusions={},
        chem21_floor={"DCM"},
    )
    assert "DCM" not in cats[0]["values"]
    assert "DCM" in applied["solvent"]


def test_apply_exclusions_disable_floor_keeps_dcm():
    cats, applied = _designer.apply_exclusions(
        categorical_inputs=[{"name": "solvent", "values": ["EtOH", "DCM"]}],
        exclusions={},
        chem21_floor={"DCM"},
        disable_chem21_floor=True,
    )
    assert "DCM" in cats[0]["values"]
    assert applied == {}


def test_apply_exclusions_empty_categorical_raises():
    with pytest.raises(ValueError, match="empty_categorical:solvent"):
        _designer.apply_exclusions(
            categorical_inputs=[{"name": "solvent", "values": ["DCM"]}],
            exclusions={"solvents": ["DCM"]},
            chem21_floor=set(),
        )


def test_design_plate_deterministic_seed():
    """Same seed → identical samples."""
    args = {
        "plate_format": "24",
        "factors": [{"name": "temperature_c", "type": "continuous", "range": [25, 100]}],
        "categorical_inputs": [{"name": "solvent", "values": ["EtOH", "Toluene"]}],
        "exclusions": {},
        "n_wells": 4,
        "seed": 42,
        "chem21_floor": _CHEM21,
    }
    a = _designer.design_plate(**args)
    b = _designer.design_plate(**args)
    assert [w["factor_values"] for w in a["wells"]] == [
        w["factor_values"] for w in b["wells"]
    ]


def test_design_plate_n_wells_exceeds_capacity():
    with pytest.raises(ValueError, match="exceeds plate"):
        _designer.design_plate(
            plate_format="24",
            factors=[{"name": "t", "type": "continuous", "range": [0, 1]}],
            categorical_inputs=[],
            exclusions={},
            n_wells=100,
            seed=0,
            chem21_floor=set(),
        )


def test_endpoint_happy_path(client):
    r = client.post(
        "/design_plate",
        json={
            "plate_format": "24",
            "reactants_smiles": "CC.CC",
            "product_smiles": "CO",
            "factors": [{"name": "temperature_c", "type": "continuous", "range": [25, 100]}],
            "categorical_inputs": [{"name": "solvent", "values": ["EtOH", "2-MeTHF"]}],
            "exclusions": {"solvents": []},
            "n_wells": 4,
            "seed": 42,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["wells"]) == 4
    assert body["wells"][0]["well_id"] == "A01"
    assert body["wells"][0]["rxn_smiles"] == "CC.CC>>CO"
    assert body["design_metadata"]["plate_format"] == "24"


def test_endpoint_rejects_reaction_arrow_in_reactants(client):
    """`reactants_smiles` is a molecule SMILES, not a reaction — `>>` must be rejected."""
    r = client.post(
        "/design_plate",
        json={
            "plate_format": "24",
            "reactants_smiles": "CC>>CC",
            "product_smiles": "CO",
            "factors": [{"name": "temperature_c", "type": "continuous", "range": [25, 100]}],
            "categorical_inputs": [{"name": "solvent", "values": ["EtOH"]}],
            "n_wells": 2,
        },
    )
    assert r.status_code == 422


def test_endpoint_excludes_dcm_via_floor(client):
    """User listed DCM in candidates; CHEM21 floor auto-excludes."""
    r = client.post(
        "/design_plate",
        json={
            "plate_format": "24",
            "factors": [{"name": "t", "type": "continuous", "range": [25, 100]}],
            "categorical_inputs": [
                {"name": "solvent", "values": ["EtOH", "DCM", "Toluene"]}
            ],
            "n_wells": 4,
            "seed": 0,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    seen = {w["factor_values"]["solvent"] for w in body["wells"]}
    assert "DCM" not in seen
    assert "DCM" in body["design_metadata"]["applied_chem21_floor"]["solvent"]


def test_endpoint_empty_categorical_returns_422(client):
    r = client.post(
        "/design_plate",
        json={
            "plate_format": "24",
            "factors": [{"name": "t", "type": "continuous", "range": [0, 1]}],
            "categorical_inputs": [{"name": "solvent", "values": ["DCM"]}],
            "exclusions": {"solvents": ["DCM"]},
            "n_wells": 4,
        },
    )
    assert r.status_code == 422
    assert "empty_categorical:solvent" in r.json().get("detail", "")


def test_endpoint_no_factors_returns_422(client):
    r = client.post(
        "/design_plate",
        json={"plate_format": "24", "n_wells": 4},
    )
    assert r.status_code == 422


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-plate-designer"


def test_readyz(client):
    r = client.get("/readyz")
    assert r.status_code == 200
