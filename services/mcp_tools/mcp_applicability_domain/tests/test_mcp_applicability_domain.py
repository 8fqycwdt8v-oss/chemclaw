"""Tests for mcp-applicability-domain FastAPI app."""
from __future__ import annotations

from pathlib import Path
from unittest import mock

import numpy as np
import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client():
    from services.mcp_tools.mcp_applicability_domain.main import app  # noqa: PLC0415
    with TestClient(app) as c:
        yield c


def _vec(seed: int, n: int = 2048) -> list[float]:
    """Deterministic 0/1 vector for tests."""
    rng = np.random.default_rng(seed)
    return rng.integers(0, 2, size=n).astype(float).tolist()


# ---------------------------------------------------------------------------
# /healthz + /readyz + stats artifact
# ---------------------------------------------------------------------------

def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-applicability-domain"


def test_readyz_503_when_stats_missing(tmp_path):
    missing = tmp_path / "no_stats.json"
    with mock.patch(
        "services.mcp_tools.mcp_applicability_domain.main._STATS_PATH",
        missing,
    ):
        from services.mcp_tools.mcp_applicability_domain.main import app
        # Re-trigger startup so _STATS reloads against the missing path.
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 503


def test_stats_artifact_loads(client):
    """The shipped drfp_stats_v1.json artifact loads at startup."""
    from services.mcp_tools.mcp_applicability_domain.main import _STATS  # noqa: PLC0415
    assert _STATS is not None
    assert "mean" in _STATS
    assert "var_diag" in _STATS
    assert len(_STATS["mean"]) == 2048
    assert len(_STATS["var_diag"]) == 2048
    assert _STATS["n_train"] >= 1
    assert "threshold_in" in _STATS
    assert "threshold_out" in _STATS


# ---------------------------------------------------------------------------
# /calibrate
# ---------------------------------------------------------------------------

def test_calibrate_returns_id(client):
    r = client.post(
        "/calibrate",
        json={
            "project_id": "00000000-0000-0000-0000-000000000001",
            "residuals": [5.0, 10.0, 15.0, 20.0, 25.0],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert "calibration_id" in body
    assert body["calibration_size"] == 5


def test_calibrate_deterministic_id(client):
    body = {
        "project_id": "00000000-0000-0000-0000-000000000001",
        "residuals": [5.0, 10.0, 15.0],
    }
    r1 = client.post("/calibrate", json=body).json()
    r2 = client.post("/calibrate", json=body).json()
    assert r1["calibration_id"] == r2["calibration_id"]


def test_calibrate_residuals_must_be_nonempty(client):
    r = client.post(
        "/calibrate",
        json={"project_id": "00000000-0000-0000-0000-000000000001", "residuals": []},
    )
    assert r.status_code in (400, 422)


def test_calibrate_residuals_must_be_nonneg(client):
    r = client.post(
        "/calibrate",
        json={"project_id": "00000000-0000-0000-0000-000000000001", "residuals": [-1.0]},
    )
    assert r.status_code in (400, 422)


# ---------------------------------------------------------------------------
# /assess
# ---------------------------------------------------------------------------

def test_assess_tanimoto_in_band(client):
    """nearest_neighbor_distance <= 0.50 → tanimoto.in_band=True."""
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": _vec(1),
            "nearest_neighbor_distance": 0.30,
            "calibration_id": None,
            "inline_residuals": [10.0] * 50,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["tanimoto_signal"]["in_band"] is True
    assert body["tanimoto_signal"]["distance"] == pytest.approx(0.30)


def test_assess_tanimoto_out_of_band(client):
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": _vec(2),
            "nearest_neighbor_distance": 0.85,
            "inline_residuals": [10.0] * 50,
        },
    )
    body = r.json()
    assert body["tanimoto_signal"]["in_band"] is False


def test_assess_mahalanobis_signal_bounded(client):
    """A vector close to the mean has small Mahalanobis distance."""
    from services.mcp_tools.mcp_applicability_domain.main import _STATS
    mean = _STATS["mean"]
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": list(mean),
            "nearest_neighbor_distance": 0.4,
            "inline_residuals": [10.0] * 50,
        },
    )
    body = r.json()
    assert body["mahalanobis_signal"]["mahalanobis"] >= 0
    assert body["mahalanobis_signal"]["in_band"] is True


def test_assess_conformal_uses_inline_residuals(client):
    """80% quantile of a 40-element residual list resolves the conformal signal."""
    # 40 evenly-spaced residuals from 5..200 in steps of 5; 80% quantile = 165.
    residuals = [5.0 * i for i in range(1, 41)]
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": _vec(3),
            "nearest_neighbor_distance": 0.4,
            "inline_residuals": residuals,
        },
    )
    body = r.json()
    cs = body["conformal_signal"]
    assert cs is not None
    assert cs["half_width"] == pytest.approx(165.0, abs=5.0)
    assert cs["alpha"] == pytest.approx(0.20)
    assert cs["in_band"] is False  # 165 > threshold_out=50


def test_assess_conformal_abstains_when_no_residuals(client):
    """Empty inline_residuals + no calibration_id → conformal abstains."""
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": _vec(4),
            "nearest_neighbor_distance": 0.4,
            "inline_residuals": [],
        },
    )
    body = r.json()
    assert body["conformal_signal"] is None
    assert body["used_global_fallback"] is True


def test_assess_calibration_id_unknown_returns_404(client):
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": _vec(5),
            "nearest_neighbor_distance": 0.4,
            "calibration_id": "deadbeef00000000",
        },
    )
    assert r.status_code == 404
    assert "calibration_id_unknown" in r.json().get("detail", "")


def test_assess_verdict_in_domain(client):
    """All 3 signals in_band → verdict 'in_domain'."""
    from services.mcp_tools.mcp_applicability_domain.main import _STATS
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": list(_STATS["mean"]),
            "nearest_neighbor_distance": 0.2,
            "inline_residuals": [5.0] * 50,
        },
    )
    body = r.json()
    assert body["verdict"] == "in_domain"


def test_assess_verdict_borderline_majority(client):
    """2 of 3 signals in_band → verdict 'borderline'."""
    from services.mcp_tools.mcp_applicability_domain.main import _STATS
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": list(_STATS["mean"]),
            "nearest_neighbor_distance": 0.85,  # tanimoto OUT
            "inline_residuals": [5.0] * 50,      # conformal in_band
        },
    )
    assert r.json()["verdict"] == "borderline"


def test_assess_verdict_out_of_domain(client):
    """0 of 3 signals in_band → 'out_of_domain'."""
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": _vec(6),
            "nearest_neighbor_distance": 0.85,
            "inline_residuals": [60.0] * 50,
        },
    )
    body = r.json()
    assert body["verdict"] == "out_of_domain"


def test_assess_verdict_with_conformal_abstain_strict(client):
    """Conformal abstains, both other signals must be in_band for 'in_domain'."""
    from services.mcp_tools.mcp_applicability_domain.main import _STATS
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": list(_STATS["mean"]),
            "nearest_neighbor_distance": 0.2,
            "inline_residuals": [],
        },
    )
    body = r.json()
    assert body["used_global_fallback"] is True
    assert body["verdict"] == "in_domain"
