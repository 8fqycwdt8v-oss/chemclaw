"""Tests for mcp-chemprop FastAPI app.

chemprop / torch are mocked — not installed in dev .venv.
"""
from __future__ import annotations

from pathlib import Path
from unittest import mock

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def client():
    with mock.patch("services.mcp_tools.mcp_chemprop.main._MODEL_DIR", Path("/")):
        from services.mcp_tools.mcp_chemprop.main import app
        with TestClient(app) as c:
            yield c


def _mock_chemprop_predict(pairs: list[tuple[float, float]]):
    return mock.patch(
        "services.mcp_tools.mcp_chemprop.main._chemprop_predict",
        return_value=pairs,
    )


# ---------------------------------------------------------------------------
# /readyz
# ---------------------------------------------------------------------------

def test_readyz_503_when_model_dir_missing(tmp_path):
    missing = tmp_path / "models"
    with mock.patch("services.mcp_tools.mcp_chemprop.main._MODEL_DIR", missing):
        from services.mcp_tools.mcp_chemprop.main import app
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 503


def test_readyz_200_when_model_dir_present():
    with mock.patch("services.mcp_tools.mcp_chemprop.main._MODEL_DIR", Path("/")):
        from services.mcp_tools.mcp_chemprop.main import app
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 200


# ---------------------------------------------------------------------------
# /predict_yield
# ---------------------------------------------------------------------------

def test_predict_yield_happy_path(client):
    with _mock_chemprop_predict([(85.3, 2.1), (60.0, 5.0)]):
        r = client.post(
            "/predict_yield",
            json={"rxn_smiles_list": ["CC>>CC", "OO>>OO"]},
        )
    assert r.status_code == 200
    body = r.json()
    assert len(body["predictions"]) == 2
    assert body["predictions"][0]["predicted_yield"] == pytest.approx(85.3)
    assert body["predictions"][0]["std"] == pytest.approx(2.1)
    assert body["predictions"][0]["model_id"] == "yield_model@v1"


def test_predict_yield_exceeds_max_returns_422(client):
    many = ["CC>>CC"] * 101
    r = client.post("/predict_yield", json={"rxn_smiles_list": many})
    assert r.status_code == 422


def test_predict_yield_empty_list_returns_422(client):
    r = client.post("/predict_yield", json={"rxn_smiles_list": []})
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# /predict_property
# ---------------------------------------------------------------------------

def test_predict_property_logP(client):
    with _mock_chemprop_predict([(2.5, 0.1)]):
        r = client.post(
            "/predict_property",
            json={"smiles_list": ["c1ccccc1"], "property": "logP"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["predictions"][0]["value"] == pytest.approx(2.5)
    assert body["predictions"][0]["smiles"] == "c1ccccc1"


def test_predict_property_invalid_enum_rejected(client):
    r = client.post(
        "/predict_property",
        json={"smiles_list": ["C"], "property": "boilingPoint"},
    )
    assert r.status_code == 422


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-chemprop"
