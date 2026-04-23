"""Integration tests for the mcp-tabicl FastAPI app.

Uses TestClient + a monkey-patched inference layer so tests don't
download or invoke TabICL. PCA-artifact presence gates /readyz.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest import mock

import numpy as np
import pytest
from fastapi.testclient import TestClient

from services.mcp_tools.mcp_tabicl.main import build_app
from services.mcp_tools.mcp_tabicl.pca import (
    PCA_N_COMPONENTS, PCA_N_FEATURES, fit_and_save,
)
from services.mcp_tools.mcp_tabicl.inference import PredictResult


@pytest.fixture()
def pca_path(tmp_path: Path) -> Path:
    rng = np.random.default_rng(0)
    X = rng.integers(0, 2, size=(PCA_N_COMPONENTS + 5, PCA_N_FEATURES)).astype("float64")
    p = tmp_path / "drfp_pca.json"
    fit_and_save(X, p)
    return p


def test_readyz_503_when_missing(tmp_path: Path) -> None:
    p = tmp_path / "missing.json"
    app = build_app(pca_path=p)
    with TestClient(app) as c:
        r = c.get("/readyz")
        assert r.status_code == 503


def test_readyz_200_when_present(pca_path: Path) -> None:
    app = build_app(pca_path=pca_path)
    with TestClient(app) as c:
        r = c.get("/readyz")
        assert r.status_code == 200


def test_featurize_happy_path(pca_path: Path) -> None:
    app = build_app(pca_path=pca_path)
    with TestClient(app) as c:
        payload = {
            "reaction_rows": [
                {
                    "reaction_id": "00000000-0000-0000-0000-000000000001",
                    "rxn_smiles": "BrC1=CC=CC=C1.OB(O)C1=CC=CC=C1>>C1=CC=C(C=C1)C2=CC=CC=C2",
                    "rxno_class": "3.1.1", "solvent": "toluene", "temp_c": 80.0,
                    "time_min": 1440.0, "catalyst_loading_mol_pct": 2.0, "base": "K2CO3",
                    "yield_pct": 88.0,
                }
            ],
            "include_targets": True,
        }
        r = c.post("/featurize", json=payload)
        assert r.status_code == 200
        body = r.json()
        assert body["targets"] == [88.0]
        assert len(body["rows"]) == 1
        assert body["skipped"] == []


def test_predict_and_rank_uses_inference(pca_path: Path) -> None:
    app = build_app(pca_path=pca_path)
    fake = PredictResult(
        predictions=np.array([72.0]), prediction_std=np.array([3.0]),
        feature_importance={"temp_c": 0.2},
    )
    with TestClient(app) as c, mock.patch(
        "services.mcp_tools.mcp_tabicl.main.predict_and_rank", return_value=fake,
    ):
        r = c.post(
            "/predict_and_rank",
            json={
                "support_rows": [[0.1] * (PCA_N_COMPONENTS + 6)],
                "support_targets": [50.0],
                "query_rows": [[0.2] * (PCA_N_COMPONENTS + 6)],
                "feature_names": [f"drfp_pc_{i+1}" for i in range(PCA_N_COMPONENTS)]
                + ["rxno_class","solvent_class","temp_c","time_min",
                   "catalyst_loading_mol_pct","base_class"],
                "categorical_names": ["rxno_class","solvent_class","base_class"],
                "task": "regression",
                "return_feature_importance": True,
            },
        )
        assert r.status_code == 200
        body = r.json()
        assert body["predictions"] == [72.0]
        assert body["feature_importance"]["temp_c"] == pytest.approx(0.2)


def test_row_cap_rejection(pca_path: Path) -> None:
    app = build_app(pca_path=pca_path)
    with TestClient(app) as c:
        payload = {
            "reaction_rows": [
                {"reaction_id": str(i), "rxn_smiles": "CC>>CC",
                 "rxno_class": None, "solvent": None, "temp_c": None,
                 "time_min": None, "catalyst_loading_mol_pct": None,
                 "base": None, "yield_pct": None}
                for i in range(1001)
            ],
            "include_targets": False,
        }
        r = c.post("/featurize", json=payload)
        assert r.status_code == 400
