"""Tests for mcp-aizynth FastAPI app.

AiZynthFinder is mocked — not installed in dev .venv.
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
def client(tmp_path):
    config = tmp_path / "config.yml"
    config.write_text("# stub config")
    with mock.patch("services.mcp_tools.mcp_aizynth.main._CONFIG_PATH", config):
        from services.mcp_tools.mcp_aizynth.main import app
        with TestClient(app) as c:
            yield c


FAKE_ROUTE_DICT = {
    "tree": {"smiles": "CCO", "children": []},
    "score": 0.78,
    "in_stock_ratio": 0.9,
}


def _mock_finder():
    finder = mock.MagicMock()
    mock_routes = mock.MagicMock()
    mock_routes.make_dicts.return_value = [FAKE_ROUTE_DICT]
    finder.routes = mock_routes
    return finder


# ---------------------------------------------------------------------------
# /readyz
# ---------------------------------------------------------------------------

def test_readyz_503_when_config_missing(tmp_path):
    missing = tmp_path / "config.yml"
    with mock.patch("services.mcp_tools.mcp_aizynth.main._CONFIG_PATH", missing):
        from services.mcp_tools.mcp_aizynth.main import app
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 503


def test_readyz_200_when_config_present(tmp_path):
    # Create a real config file so _is_ready returns True.
    config = tmp_path / "config.yml"
    config.write_text("# stub config")
    with mock.patch("services.mcp_tools.mcp_aizynth.main._CONFIG_PATH", config):
        from services.mcp_tools.mcp_aizynth.main import app
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 200


# ---------------------------------------------------------------------------
# /retrosynthesis
# ---------------------------------------------------------------------------

def test_retrosynthesis_happy_path(client):
    finder = _mock_finder()
    with mock.patch(
        "services.mcp_tools.mcp_aizynth.main._get_finder",
        return_value=finder,
    ):
        r = client.post(
            "/retrosynthesis",
            json={"smiles": "CCO", "max_iterations": 50},
        )
    assert r.status_code == 200
    body = r.json()
    assert len(body["routes"]) == 1
    assert body["routes"][0]["score"] == pytest.approx(0.78)
    assert body["routes"][0]["in_stock_ratio"] == pytest.approx(0.9)
    assert body["routes"][0]["tree"]["smiles"] == "CCO"


def test_retrosynthesis_empty_smiles_returns_400(client):
    with mock.patch(
        "services.mcp_tools.mcp_aizynth.main._get_finder",
        return_value=_mock_finder(),
    ):
        r = client.post("/retrosynthesis", json={"smiles": "   "})
    assert r.status_code == 400


def test_retrosynthesis_max_iterations_too_large_rejected(client):
    r = client.post(
        "/retrosynthesis",
        json={"smiles": "CCO", "max_iterations": 9999},
    )
    assert r.status_code == 422


def test_retrosynthesis_passes_iteration_limit_to_finder(client):
    finder = _mock_finder()
    with mock.patch(
        "services.mcp_tools.mcp_aizynth.main._get_finder",
        return_value=finder,
    ):
        client.post(
            "/retrosynthesis",
            json={"smiles": "CCO", "max_iterations": 200},
        )
    assert finder.config.iteration_limit == 200


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-aizynth"
