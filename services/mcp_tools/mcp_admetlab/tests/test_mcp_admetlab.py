"""Tests for mcp-admetlab FastAPI app.

The external ADMETlab API and local model are mocked.
httpx is installed in the dev .venv so TestClient works.
"""
from __future__ import annotations

from pathlib import Path
from unittest import mock

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FAKE_PREDICTION = {
    "smiles": "c1ccccc1",
    "endpoints": {
        "absorption": {"Caco2": 18.5, "HIA_Hou": 0.99},
        "distribution": {"VD_human": 0.8},
        "metabolism": {"CYP3A4_substrate": True},
        "excretion": {"T12": 3.0},
        "toxicity": {"hERG": "safe"},
    },
    "alerts": [],
}


def _make_app_with_api_key():
    """App configured with a fake API key (uses hosted-API path)."""
    with mock.patch("services.mcp_tools.mcp_admetlab.main._API_KEY", "FAKE_KEY"), \
         mock.patch("services.mcp_tools.mcp_admetlab.main._MODEL_DIR", Path("/nonexistent")):
        from services.mcp_tools.mcp_admetlab.main import app
        return app


def _make_app_no_backend():
    """App with no API key and no local model (should be not ready)."""
    with mock.patch("services.mcp_tools.mcp_admetlab.main._API_KEY", ""), \
         mock.patch("services.mcp_tools.mcp_admetlab.main._MODEL_DIR", Path("/nonexistent")):
        from services.mcp_tools.mcp_admetlab.main import app
        return app


# ---------------------------------------------------------------------------
# /readyz
# ---------------------------------------------------------------------------

def test_readyz_503_when_no_backend(tmp_path):
    missing = tmp_path / "no_models"
    from services.mcp_tools.mcp_admetlab.main import app
    # Empty API key + non-existent model dir → not ready.
    with mock.patch("services.mcp_tools.mcp_admetlab.main._API_KEY", ""), \
         mock.patch("services.mcp_tools.mcp_admetlab.main._MODEL_DIR", missing):
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 503


def test_readyz_200_when_api_key_present():
    from services.mcp_tools.mcp_admetlab.main import app
    with mock.patch("services.mcp_tools.mcp_admetlab.main._API_KEY", "FAKE_KEY"):
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 200


# ---------------------------------------------------------------------------
# /screen — API-key path
# ---------------------------------------------------------------------------

def test_screen_via_api_happy_path():
    from services.mcp_tools.mcp_admetlab.main import AdmetPrediction, AdmetEndpoints, app

    async def _fake_screen_api(smiles_list):
        return [
            AdmetPrediction(
                smiles="c1ccccc1",
                endpoints=AdmetEndpoints(
                    absorption={"Caco2": 18.5},
                    distribution={},
                    metabolism={},
                    excretion={},
                    toxicity={},
                ),
                alerts=[],
            )
        ]

    with TestClient(app) as c, \
         mock.patch("services.mcp_tools.mcp_admetlab.main._API_KEY", "FAKE_KEY"), \
         mock.patch(
             "services.mcp_tools.mcp_admetlab.main._screen_via_api",
             side_effect=_fake_screen_api,
         ):
        r = c.post("/screen", json={"smiles_list": ["c1ccccc1"]})

    assert r.status_code == 200
    body = r.json()
    assert len(body["predictions"]) == 1
    assert body["predictions"][0]["smiles"] == "c1ccccc1"
    assert body["predictions"][0]["endpoints"]["absorption"]["Caco2"] == pytest.approx(18.5)


def test_screen_exceeds_max_smiles_rejected():
    from services.mcp_tools.mcp_admetlab.main import app
    with TestClient(app) as c:
        r = c.post("/screen", json={"smiles_list": ["C"] * 51})
    assert r.status_code == 422


def test_screen_empty_smiles_in_list_returns_400():
    from services.mcp_tools.mcp_admetlab.main import app
    with TestClient(app) as c, \
         mock.patch("services.mcp_tools.mcp_admetlab.main._API_KEY", "FAKE_KEY"):
        r = c.post("/screen", json={"smiles_list": ["c1ccccc1", ""]})
    assert r.status_code == 400


def test_healthz():
    from services.mcp_tools.mcp_admetlab.main import app
    with TestClient(app) as c:
        r = c.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-admetlab"
