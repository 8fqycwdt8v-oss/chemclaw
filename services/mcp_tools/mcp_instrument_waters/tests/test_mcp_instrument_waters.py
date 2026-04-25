"""Tests for mcp-instrument-waters FastAPI app.

Waters Empower HTTP client is mocked — no real credentials required in dev .venv.
"""
from __future__ import annotations

from unittest import mock

import pytest
from fastapi.testclient import TestClient

import services.mcp_tools.mcp_instrument_waters.main as waters_main

# --------------------------------------------------------------------------
# Sample data
# --------------------------------------------------------------------------
FAKE_RUN = {
    "RunID": "run_W001",
    "SampleName": "NCE-001-Batch-A",
    "MethodName": "HPLC-C18-Standard",
    "InstrumentName": "AcquityUPLC-01",
    "RunDate": "2024-04-01T09:15:00Z",
    "peaks": [
        {"Name": "Main Peak", "RT": 3.42, "Area": 985000.0, "Height": 120000.0, "AreaPct": 98.5},
        {"Name": "Impurity A", "RT": 4.10, "Area": 14750.0, "Height": 1800.0, "AreaPct": 1.5},
    ],
}

FAKE_SEARCH_RESPONSE = {"runs": [FAKE_RUN], "totalCount": 1}


# --------------------------------------------------------------------------
# Client fixture
# --------------------------------------------------------------------------
@pytest.fixture()
def client():
    with TestClient(waters_main.app) as c:
        yield c


def _mock_response(status_code: int, json_data):
    resp = mock.MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_data
    resp.raise_for_status = mock.MagicMock()
    return resp


def _mock_factory(get_response=None, post_response=None):
    mock_client = mock.AsyncMock()
    if get_response is not None:
        mock_client.get.return_value = get_response
    if post_response is not None:
        mock_client.post.return_value = post_response

    class _Ctx:
        async def __aenter__(self):
            return mock_client
        async def __aexit__(self, *_):
            pass

    return lambda: _Ctx()


# --------------------------------------------------------------------------
# /healthz
# --------------------------------------------------------------------------
def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-instrument-waters"


# --------------------------------------------------------------------------
# /readyz
# --------------------------------------------------------------------------
def test_readyz_503_without_api_key(monkeypatch, client):
    monkeypatch.setattr(waters_main, "_WATERS_API_KEY", "")
    r = client.get("/readyz")
    assert r.status_code == 503


def test_readyz_200_with_api_key(monkeypatch, client):
    monkeypatch.setattr(waters_main, "_WATERS_API_KEY", "wk_fakekey123")
    r = client.get("/readyz")
    assert r.status_code == 200


# --------------------------------------------------------------------------
# GET /run/{id}
# --------------------------------------------------------------------------
def test_get_run_happy_path(monkeypatch, client):
    monkeypatch.setattr(waters_main, "_client_factory", _mock_factory(get_response=_mock_response(200, FAKE_RUN)))

    r = client.get("/run/run_W001")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == "run_W001"
    assert body["sample_name"] == "NCE-001-Batch-A"
    assert body["method_name"] == "HPLC-C18-Standard"
    assert len(body["peaks"]) == 2
    assert body["peaks"][0]["retention_time_min"] == pytest.approx(3.42)
    assert body["peaks"][0]["area_pct"] == pytest.approx(98.5)
    assert body["total_area"] == pytest.approx(985000.0 + 14750.0)


def test_get_run_404_returns_400(monkeypatch, client):
    monkeypatch.setattr(waters_main, "_client_factory", _mock_factory(get_response=_mock_response(404, {})))

    r = client.get("/run/run_missing")
    assert r.status_code == 400
    assert "not found" in r.json()["detail"].lower()


# --------------------------------------------------------------------------
# POST /search_runs
# --------------------------------------------------------------------------
def test_search_runs_happy_path(monkeypatch, client):
    monkeypatch.setattr(waters_main, "_client_factory", _mock_factory(post_response=_mock_response(200, FAKE_SEARCH_RESPONSE)))

    r = client.post("/search_runs", json={"sample_name": "NCE-001", "limit": 10})
    assert r.status_code == 200
    body = r.json()
    assert len(body["runs"]) == 1
    assert body["runs"][0]["id"] == "run_W001"
    assert body["total_count"] == 1


def test_search_runs_limit_validation(client):
    r = client.post("/search_runs", json={"limit": 9999})
    assert r.status_code == 422


def test_search_runs_passes_filters(monkeypatch, client):
    mock_client = mock.AsyncMock()
    mock_client.post.return_value = _mock_response(200, [])

    class _Ctx:
        async def __aenter__(self):
            return mock_client
        async def __aexit__(self, *_):
            pass

    monkeypatch.setattr(waters_main, "_client_factory", lambda: _Ctx())

    client.post(
        "/search_runs",
        json={"sample_name": "NCE", "method_name": "C18", "date_from": "2024-01-01", "date_to": "2024-12-31"},
    )

    call_args = mock_client.post.call_args
    payload = call_args[1].get("json", {})
    assert payload.get("sampleName") == "NCE"
    assert payload.get("methodName") == "C18"
    assert payload.get("dateFrom") == "2024-01-01"
    assert payload.get("dateTo") == "2024-12-31"


def test_search_runs_empty(monkeypatch, client):
    monkeypatch.setattr(waters_main, "_client_factory", _mock_factory(post_response=_mock_response(200, [])))

    r = client.post("/search_runs", json={})
    assert r.status_code == 200
    assert r.json()["runs"] == []
