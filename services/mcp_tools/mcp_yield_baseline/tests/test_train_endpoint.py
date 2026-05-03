"""/train endpoint + LRU cache tests. DRFP encoder is mocked."""
from __future__ import annotations

from unittest import mock

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


def _mock_drfp():
    """Patch the local DRFP encoder helper to return deterministic vectors."""

    def fake_encode(rxn_smiles_list: list[str]) -> list[list[float]]:
        rng = np.random.default_rng(seed=hash(tuple(rxn_smiles_list)) & 0xFFFF_FFFF)
        return rng.integers(0, 2, size=(len(rxn_smiles_list), 2048)).astype(float).tolist()

    return mock.patch(
        "services.mcp_tools.mcp_yield_baseline.main._encode_drfp_batch",
        side_effect=fake_encode,
    )


def test_train_returns_model_id(client):
    pairs = [
        {"rxn_smiles": f"CC>>CC{i}", "yield_pct": 50.0 + i}
        for i in range(60)
    ]
    with _mock_drfp():
        r = client.post(
            "/train",
            json={
                "project_internal_id": "PRJ-001",
                "training_pairs": pairs,
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "model_id" in body
    assert body["model_id"].startswith("PRJ-001@")
    assert body["n_train"] == 60


def test_train_deterministic_id(client):
    pairs = [
        {"rxn_smiles": f"CC>>CC{i}", "yield_pct": 50.0 + i}
        for i in range(60)
    ]
    with _mock_drfp():
        r1 = client.post(
            "/train",
            json={"project_internal_id": "PRJ-A", "training_pairs": pairs},
        ).json()
        r2 = client.post(
            "/train",
            json={"project_internal_id": "PRJ-A", "training_pairs": pairs},
        ).json()
    assert r1["model_id"] == r2["model_id"]


def test_train_rejects_too_few_pairs(client):
    pairs = [{"rxn_smiles": "CC>>CC", "yield_pct": 50.0}]
    r = client.post(
        "/train",
        json={"project_internal_id": "PRJ-X", "training_pairs": pairs},
    )
    assert r.status_code in (400, 422)


def test_train_rejects_degenerate_variance(client):
    """All-identical yields can't train a useful regressor → 422."""
    pairs = [
        {"rxn_smiles": f"CC>>CC{i}", "yield_pct": 50.0}  # variance == 0
        for i in range(60)
    ]
    with _mock_drfp():
        r = client.post(
            "/train",
            json={"project_internal_id": "PRJ-DEGEN", "training_pairs": pairs},
        )
    assert r.status_code == 422
    assert "training_failed" in r.json().get("detail", "")
