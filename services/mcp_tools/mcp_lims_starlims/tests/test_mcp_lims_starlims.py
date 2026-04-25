"""Tests for mcp-lims-starlims FastAPI app.

STARLIMS HTTP client is mocked — no real credentials required in dev .venv.
"""
from __future__ import annotations

from unittest import mock

import pytest
from fastapi.testclient import TestClient

import services.mcp_tools.mcp_lims_starlims.main as lims_main

# --------------------------------------------------------------------------
# Sample data
# --------------------------------------------------------------------------
FAKE_RESULT = {
    "ResultID": "res_9001",
    "SampleID": "smp_A01",
    "MethodID": "meth_hplc_purity",
    "AnalysisName": "HPLC Purity",
    "ResultValue": 98.7,
    "ResultUnit": "%",
    "Status": "Complete",
    "Analyst": "j.smith@pharma.com",
    "CompletedAt": "2024-03-10T14:22:00Z",
}

FAKE_RESULT_LIST = [FAKE_RESULT]


# --------------------------------------------------------------------------
# Client fixture
# --------------------------------------------------------------------------
@pytest.fixture()
def client():
    with TestClient(lims_main.app) as c:
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
    assert r.json()["service"] == "mcp-lims-starlims"


# --------------------------------------------------------------------------
# /readyz
# --------------------------------------------------------------------------
def test_readyz_503_without_credentials(monkeypatch, client):
    monkeypatch.setattr(lims_main, "_STARLIMS_USER", "")
    monkeypatch.setattr(lims_main, "_STARLIMS_TOKEN", "")
    r = client.get("/readyz")
    assert r.status_code == 503


def test_readyz_200_with_credentials(monkeypatch, client):
    monkeypatch.setattr(lims_main, "_STARLIMS_USER", "labuser")
    monkeypatch.setattr(lims_main, "_STARLIMS_TOKEN", "tok_secure123")
    r = client.get("/readyz")
    assert r.status_code == 200


# --------------------------------------------------------------------------
# GET /test_results/{id}
# --------------------------------------------------------------------------
def test_get_test_result_happy_path(monkeypatch, client):
    monkeypatch.setattr(lims_main, "_client_factory", _mock_factory(get_response=_mock_response(200, FAKE_RESULT)))

    r = client.get("/test_results/res_9001")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == "res_9001"
    assert body["sample_id"] == "smp_A01"
    assert body["method_id"] == "meth_hplc_purity"
    assert body["result_value"] == "98.7"
    assert body["result_unit"] == "%"
    assert body["status"] == "Complete"


def test_get_test_result_404(monkeypatch, client):
    monkeypatch.setattr(lims_main, "_client_factory", _mock_factory(get_response=_mock_response(404, {})))

    r = client.get("/test_results/res_missing")
    assert r.status_code == 400
    assert "not found" in r.json()["detail"].lower()


# --------------------------------------------------------------------------
# POST /query_results
# --------------------------------------------------------------------------
def test_query_results_happy_path(monkeypatch, client):
    monkeypatch.setattr(lims_main, "_client_factory", _mock_factory(post_response=_mock_response(200, FAKE_RESULT_LIST)))

    r = client.post("/query_results", json={"sample_id": "smp_A01", "limit": 20})
    assert r.status_code == 200
    body = r.json()
    assert len(body["results"]) == 1
    assert body["results"][0]["id"] == "res_9001"


def test_query_results_limit_over_500_rejected(client):
    r = client.post("/query_results", json={"limit": 9999})
    assert r.status_code == 422


def test_query_results_passes_filters(monkeypatch, client):
    mock_client = mock.AsyncMock()
    mock_client.post.return_value = _mock_response(200, [])

    class _Ctx:
        async def __aenter__(self):
            return mock_client
        async def __aexit__(self, *_):
            pass

    monkeypatch.setattr(lims_main, "_client_factory", lambda: _Ctx())

    client.post(
        "/query_results",
        json={"sample_id": "smp_X", "method_id": "meth_Y", "since": "2024-01-01T00:00:00Z"},
    )

    call_args = mock_client.post.call_args
    payload = call_args[1].get("json", {})
    assert payload.get("sampleId") == "smp_X"
    assert payload.get("methodId") == "meth_Y"
    assert payload.get("completedAfter") == "2024-01-01T00:00:00Z"


def test_query_results_empty(monkeypatch, client):
    monkeypatch.setattr(lims_main, "_client_factory", _mock_factory(post_response=_mock_response(200, [])))

    r = client.post("/query_results", json={})
    assert r.status_code == 200
    assert r.json()["results"] == []
