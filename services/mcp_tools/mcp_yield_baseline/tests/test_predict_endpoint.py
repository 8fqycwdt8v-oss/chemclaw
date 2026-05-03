"""/predict_yield endpoint tests. drfp + chemprop both mocked."""
from __future__ import annotations

from unittest import mock

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client():
    from services.mcp_tools.mcp_yield_baseline import cache as _cache
    _cache.clear()
    from services.mcp_tools.mcp_yield_baseline.main import app  # noqa: PLC0415
    with TestClient(app) as c:
        yield c


def _mock_drfp_batch():
    def fake_encode(rxn_smiles_list: list[str]) -> list[list[float]]:
        rng = np.random.default_rng(seed=hash(tuple(rxn_smiles_list)) & 0xFFFF_FFFF)
        return rng.integers(0, 2, size=(len(rxn_smiles_list), 2048)).astype(float).tolist()
    return mock.patch(
        "services.mcp_tools.mcp_yield_baseline.main._encode_drfp_batch",
        side_effect=fake_encode,
    )


def _mock_chemprop(returns):
    def fake_chemprop(rxn_smiles_list: list[str]) -> list[tuple[float, float]]:
        return [returns[s] for s in rxn_smiles_list]
    return mock.patch(
        "services.mcp_tools.mcp_yield_baseline.main._call_chemprop_batch",
        side_effect=fake_chemprop,
    )


def _seed_project_model(client, project: str = "PRJ-PRED") -> str:
    pairs = [
        {"rxn_smiles": f"CC>>CC{i}", "yield_pct": 50.0 + (i * 0.5)}
        for i in range(60)
    ]
    with _mock_drfp_batch():
        r = client.post(
            "/train",
            json={"project_internal_id": project, "training_pairs": pairs},
        )
    return r.json()["model_id"]


def test_predict_with_cached_model_returns_ensemble(client):
    model_id = _seed_project_model(client)
    chem = {"O>>P": (60.0, 5.0)}
    with _mock_drfp_batch(), _mock_chemprop(chem):
        r = client.post(
            "/predict_yield",
            json={
                "rxn_smiles_list": ["O>>P"],
                "project_internal_id": "PRJ-PRED",
                "model_id": model_id,
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["predictions"]) == 1
    pred = body["predictions"][0]
    assert "ensemble_mean" in pred
    assert "ensemble_std" in pred
    assert pred["components"]["chemprop_mean"] == 60.0
    assert pred["components"]["chemprop_std"] == 5.0
    assert "xgboost_mean" in pred["components"]
    assert pred["used_global_fallback"] is False


def test_predict_unknown_model_id_returns_412(client):
    chem = {"O>>P": (60.0, 5.0)}
    with _mock_drfp_batch(), _mock_chemprop(chem):
        r = client.post(
            "/predict_yield",
            json={
                "rxn_smiles_list": ["O>>P"],
                "project_internal_id": "PRJ-PRED",
                "model_id": "PRJ-PRED@deadbeef00000000",
            },
        )
    assert r.status_code == 412
    assert "needs_calibration" in r.json().get("detail", "")


def test_predict_global_fallback_no_model_id(client):
    chem = {"O>>P": (60.0, 5.0)}
    with _mock_drfp_batch(), _mock_chemprop(chem):
        r = client.post(
            "/predict_yield",
            json={
                "rxn_smiles_list": ["O>>P"],
                "used_global_fallback": True,
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["predictions"][0]["used_global_fallback"] is True


def test_predict_batch(client):
    model_id = _seed_project_model(client)
    chem = {"A>>X": (40.0, 3.0), "B>>Y": (75.0, 4.0)}
    with _mock_drfp_batch(), _mock_chemprop(chem):
        r = client.post(
            "/predict_yield",
            json={
                "rxn_smiles_list": ["A>>X", "B>>Y"],
                "project_internal_id": "PRJ-PRED",
                "model_id": model_id,
            },
        )
    assert r.status_code == 200, r.text
    assert len(r.json()["predictions"]) == 2


def test_predict_empty_list_rejected(client):
    r = client.post("/predict_yield", json={"rxn_smiles_list": []})
    assert r.status_code in (400, 422)


def test_predict_chemprop_failure_propagates_503(client):
    model_id = _seed_project_model(client)

    def fake_chemprop(rxn_smiles_list):
        raise httpx.HTTPError("chemprop down")

    with _mock_drfp_batch(), mock.patch(
        "services.mcp_tools.mcp_yield_baseline.main._call_chemprop_batch",
        side_effect=fake_chemprop,
    ):
        r = client.post(
            "/predict_yield",
            json={
                "rxn_smiles_list": ["O>>P"],
                "project_internal_id": "PRJ-PRED",
                "model_id": model_id,
            },
        )
    assert r.status_code == 503
