"""Skeleton tests for mcp-yield-baseline FastAPI app."""
from __future__ import annotations

from pathlib import Path
from unittest import mock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client():
    from services.mcp_tools.mcp_yield_baseline.main import app  # noqa: PLC0415
    with TestClient(app) as c:
        yield c


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-yield-baseline"


def test_readyz_503_when_global_artifact_missing(tmp_path):
    missing = tmp_path / "no_xgb.json"
    with mock.patch(
        "services.mcp_tools.mcp_yield_baseline.main._GLOBAL_XGB_PATH",
        missing,
    ):
        from services.mcp_tools.mcp_yield_baseline.main import app
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 503


def test_global_xgb_loads_at_startup(client):
    from services.mcp_tools.mcp_yield_baseline.main import _GLOBAL_XGB_MODEL  # noqa: PLC0415
    assert _GLOBAL_XGB_MODEL is not None
