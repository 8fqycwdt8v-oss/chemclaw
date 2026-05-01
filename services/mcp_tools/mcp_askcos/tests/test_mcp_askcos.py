"""Tests for mcp-askcos FastAPI app.

ASKCOS client is mocked — no askcos2 package required in dev .venv.
"""
from __future__ import annotations

from pathlib import Path
from unittest import mock

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Helpers — patch the heavy client before importing main
# ---------------------------------------------------------------------------

def _make_app(model_dir_exists: bool = True):
    """Build the FastAPI app with a faked model dir and a mocked ASKCOS client."""
    with mock.patch(
        "services.mcp_tools.mcp_askcos.main._MODEL_DIR",
        Path("/fake/models") if not model_dir_exists else Path("/"),  # "/" always exists
    ):
        from services.mcp_tools.mcp_askcos.main import app  # noqa: PLC0415
        return app


@pytest.fixture()
def client():
    app = _make_app(model_dir_exists=True)
    with TestClient(app) as c:
        yield c


FAKE_RETRO_ROUTES = [
    {
        "steps": [
            {"reaction_smiles": "CC(=O)O.CC>>CC(=O)OCC", "score": 0.85, "sources_count": 3},
            {"reaction_smiles": "CC>>C", "score": 0.70, "sources_count": 1},
        ],
        "total_score": 0.60,
    }
]

FAKE_PRODUCTS = [
    {"smiles": "CC(=O)OCC", "score": 0.92},
    {"smiles": "CC(=O)O", "score": 0.40},
]


# ---------------------------------------------------------------------------
# /readyz
# ---------------------------------------------------------------------------

def test_readyz_503_when_model_dir_missing(tmp_path):
    missing = tmp_path / "no_models"
    with mock.patch("services.mcp_tools.mcp_askcos.main._MODEL_DIR", missing):
        from services.mcp_tools.mcp_askcos.main import app
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 503


def test_readyz_200_when_model_dir_present():
    # Use "/" which always exists.
    with mock.patch("services.mcp_tools.mcp_askcos.main._MODEL_DIR", Path("/")):
        from services.mcp_tools.mcp_askcos.main import app
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 200


# ---------------------------------------------------------------------------
# /retrosynthesis
# ---------------------------------------------------------------------------

def test_retrosynthesis_happy_path(client):
    mock_client = mock.MagicMock()
    mock_client.retrosynthesis.return_value = FAKE_RETRO_ROUTES

    with mock.patch(
        "services.mcp_tools.mcp_askcos.main._get_askcos_client",
        return_value=mock_client,
    ):
        r = client.post(
            "/retrosynthesis",
            json={"smiles": "CC(=O)O", "max_depth": 3, "max_branches": 4},
        )
    assert r.status_code == 200
    body = r.json()
    assert len(body["routes"]) == 1
    route = body["routes"][0]
    assert route["depth"] == 2
    assert len(route["steps"]) == 2
    assert route["steps"][0]["score"] == pytest.approx(0.85)
    assert route["steps"][0]["sources_count"] == 3


def test_retrosynthesis_empty_smiles_returns_400(client):
    with mock.patch(
        "services.mcp_tools.mcp_askcos.main._get_askcos_client",
        return_value=mock.MagicMock(),
    ):
        r = client.post("/retrosynthesis", json={"smiles": "   "})
    assert r.status_code == 400


def test_retrosynthesis_max_depth_clamped(client):
    """max_depth > 6 should be rejected by Pydantic."""
    with mock.patch(
        "services.mcp_tools.mcp_askcos.main._get_askcos_client",
        return_value=mock.MagicMock(),
    ):
        r = client.post("/retrosynthesis", json={"smiles": "C", "max_depth": 99})
    assert r.status_code == 422


def test_retrosynthesis_passes_params_to_client(client):
    mock_client = mock.MagicMock()
    mock_client.retrosynthesis.return_value = []

    with mock.patch(
        "services.mcp_tools.mcp_askcos.main._get_askcos_client",
        return_value=mock_client,
    ):
        client.post(
            "/retrosynthesis",
            json={"smiles": "CCO", "max_depth": 4, "max_branches": 2},
        )

    mock_client.retrosynthesis.assert_called_once_with(
        target="CCO", max_depth=4, max_branches=2
    )


# ---------------------------------------------------------------------------
# /forward_prediction
# ---------------------------------------------------------------------------

def test_forward_prediction_happy_path(client):
    mock_client = mock.MagicMock()
    mock_client.forward_prediction.return_value = FAKE_PRODUCTS

    with mock.patch(
        "services.mcp_tools.mcp_askcos.main._get_askcos_client",
        return_value=mock_client,
    ):
        r = client.post(
            "/forward_prediction",
            json={"reactants_smiles": "CC.OO", "conditions": "reflux"},
        )
    assert r.status_code == 200
    body = r.json()
    assert len(body["products"]) == 2
    assert body["products"][0]["smiles"] == "CC(=O)OCC"
    assert body["products"][0]["score"] == pytest.approx(0.92)


def test_forward_prediction_empty_reactants_returns_400(client):
    with mock.patch(
        "services.mcp_tools.mcp_askcos.main._get_askcos_client",
        return_value=mock.MagicMock(),
    ):
        r = client.post("/forward_prediction", json={"reactants_smiles": ""})
    assert r.status_code in (400, 422)


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-askcos"


# ---------------------------------------------------------------------------
# /recommend_conditions
# ---------------------------------------------------------------------------

FAKE_CONDITIONS = [
    {
        "catalyst": [{"smiles": "[Pd]", "name": "Pd(OAc)2"}],
        "reagent": [{"smiles": "C(C)(C)(C)[O-]", "name": "tBuOK"}],
        "solvent": ["O", "C1CCOC1"],  # mixed shape: bare strings here
        "temperature": 80.0,
        "score": 0.91,
    },
    {
        "catalyst": [],
        "reagent": [{"smiles": "[Cs+]", "name": "Cs2CO3"}],
        "solvent": [{"smiles": "CCOCC", "name": "DEE"}],
        "temperature": 25.0,
        "score": 0.42,
    },
]


def test_recommend_conditions_happy_path(client):
    mock_client = mock.MagicMock()
    mock_client.recommend_conditions.return_value = FAKE_CONDITIONS

    with mock.patch(
        "services.mcp_tools.mcp_askcos.main._get_askcos_client",
        return_value=mock_client,
    ):
        r = client.post(
            "/recommend_conditions",
            json={
                "reactants_smiles": "Brc1ccc(OC)cc1.C1COCCN1",
                "product_smiles": "COc1ccc(N2CCOCC2)cc1",
                "top_k": 5,
            },
        )

    assert r.status_code == 200
    body = r.json()
    assert body["model_id"] == "askcos_condition_recommender@v2"
    assert len(body["recommendations"]) == 2

    first = body["recommendations"][0]
    assert first["score"] == pytest.approx(0.91)
    assert first["temperature_c"] == pytest.approx(80.0)
    assert len(first["catalysts"]) == 1
    assert first["catalysts"][0]["name"] == "Pd(OAc)2"
    # Bare-string solvent shape gets normalized to {smiles, name}.
    assert len(first["solvents"]) == 2
    assert first["solvents"][0]["smiles"] == "O"
    assert first["solvents"][0]["name"] == ""

    second = body["recommendations"][1]
    assert second["catalysts"] == []
    assert second["solvents"][0]["name"] == "DEE"


def test_recommend_conditions_passes_params_to_client(client):
    mock_client = mock.MagicMock()
    mock_client.recommend_conditions.return_value = []

    with mock.patch(
        "services.mcp_tools.mcp_askcos.main._get_askcos_client",
        return_value=mock_client,
    ):
        client.post(
            "/recommend_conditions",
            json={
                "reactants_smiles": "CCBr.NC",
                "product_smiles": "CCNC",
                "top_k": 3,
            },
        )

    mock_client.recommend_conditions.assert_called_once_with(
        reactants="CCBr.NC", product="CCNC", n=3
    )


def test_recommend_conditions_empty_reactants_returns_400(client):
    with mock.patch(
        "services.mcp_tools.mcp_askcos.main._get_askcos_client",
        return_value=mock.MagicMock(),
    ):
        r = client.post(
            "/recommend_conditions",
            json={"reactants_smiles": "   ", "product_smiles": "C"},
        )
    assert r.status_code == 400


def test_recommend_conditions_empty_product_returns_400(client):
    with mock.patch(
        "services.mcp_tools.mcp_askcos.main._get_askcos_client",
        return_value=mock.MagicMock(),
    ):
        r = client.post(
            "/recommend_conditions",
            json={"reactants_smiles": "CC", "product_smiles": ""},
        )
    assert r.status_code in (400, 422)


def test_recommend_conditions_top_k_clamped(client):
    with mock.patch(
        "services.mcp_tools.mcp_askcos.main._get_askcos_client",
        return_value=mock.MagicMock(),
    ):
        r = client.post(
            "/recommend_conditions",
            json={
                "reactants_smiles": "C",
                "product_smiles": "C",
                "top_k": 99,  # > 20
            },
        )
    assert r.status_code == 422


def test_recommend_conditions_temperature_can_be_null(client):
    """Some recommender outputs omit temperature; the route must accept None."""
    mock_client = mock.MagicMock()
    mock_client.recommend_conditions.return_value = [
        {
            "catalyst": [],
            "reagent": [],
            "solvent": [],
            "temperature": None,
            "score": 0.5,
        },
    ]

    with mock.patch(
        "services.mcp_tools.mcp_askcos.main._get_askcos_client",
        return_value=mock_client,
    ):
        r = client.post(
            "/recommend_conditions",
            json={"reactants_smiles": "C", "product_smiles": "C"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["recommendations"][0]["temperature_c"] is None


def test_recommend_conditions_raises_on_non_list_client_output(client):
    mock_client = mock.MagicMock()
    mock_client.recommend_conditions.return_value = {"oops": "not a list"}

    with mock.patch(
        "services.mcp_tools.mcp_askcos.main._get_askcos_client",
        return_value=mock_client,
    ):
        r = client.post(
            "/recommend_conditions",
            json={"reactants_smiles": "C", "product_smiles": "C"},
        )
    # ValueError → 400 via the create_app error handler.
    assert r.status_code == 400
