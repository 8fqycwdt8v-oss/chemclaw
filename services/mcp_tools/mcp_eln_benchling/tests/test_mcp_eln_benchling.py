"""Tests for mcp-eln-benchling FastAPI app.

The Benchling HTTP client is mocked — no real API key required in dev .venv.
"""
from __future__ import annotations

from unittest import mock

import pytest
from fastapi.testclient import TestClient

import services.mcp_tools.mcp_eln_benchling.main as eln_main

# --------------------------------------------------------------------------
# Sample data
# --------------------------------------------------------------------------
FAKE_ENTRY = {
    "id": "etr_abc123",
    "schema": {"id": "schema_xyz"},
    "fields": {
        "yield_pct": {"value": 87.5, "displayValue": "87.5%"},
        "solvent": {"value": "THF", "displayValue": "THF"},
    },
    "attachments": [
        {"id": "attach_001", "webURL": "https://example.benchling.com/files/attach_001"}
    ],
    "createdAt": "2024-01-15T10:00:00Z",
    "modifiedAt": "2024-01-16T08:30:00Z",
}

FAKE_ENTRIES_RESPONSE = {
    "entries": [FAKE_ENTRY],
    "nextToken": None,
}


# --------------------------------------------------------------------------
# Client fixture
# --------------------------------------------------------------------------
@pytest.fixture()
def client():
    with TestClient(eln_main.app) as c:
        yield c


def _mock_httpx_response(status_code: int, json_data: dict):
    """Build a mock httpx response."""
    resp = mock.MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_data
    resp.raise_for_status = mock.MagicMock()
    return resp


def _mock_async_client(get_response=None, post_response=None):
    """Return an async context manager wrapping a mock httpx.AsyncClient.

    Usage in tests:
        monkeypatch.setattr(main, "_client_factory", lambda: _mock_async_client(get_response=resp))
    Routes call `async with _client_factory() as client:`, so the lambda must
    return a context manager instance.
    """
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

    return _Ctx()


# --------------------------------------------------------------------------
# /healthz
# --------------------------------------------------------------------------
def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-eln-benchling"


# --------------------------------------------------------------------------
# /readyz
# --------------------------------------------------------------------------
def test_readyz_503_when_no_api_key(monkeypatch, client):
    monkeypatch.setattr(eln_main, "_BENCHLING_API_KEY", "")
    r = client.get("/readyz")
    assert r.status_code == 503


def test_readyz_200_when_api_key_set(monkeypatch, client):
    monkeypatch.setattr(eln_main, "_BENCHLING_API_KEY", "tok_fakefake")
    r = client.get("/readyz")
    assert r.status_code == 200


# --------------------------------------------------------------------------
# GET /experiments/{id}
# --------------------------------------------------------------------------
def test_get_experiment_happy_path(monkeypatch, client):
    resp = _mock_httpx_response(200, FAKE_ENTRY)
    monkeypatch.setattr(eln_main, "_client_factory", lambda: _mock_async_client(get_response=resp))

    r = client.get("/experiments/etr_abc123")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == "etr_abc123"
    assert body["schema_id"] == "schema_xyz"
    assert body["fields"]["yield_pct"]["value"] == pytest.approx(87.5)
    assert len(body["attached_files"]) == 1
    assert body["attached_files"][0]["document_id"] == "attach_001"


def test_get_experiment_404_returns_400(monkeypatch, client):
    resp = _mock_httpx_response(404, {"message": "not found"})
    monkeypatch.setattr(eln_main, "_client_factory", lambda: _mock_async_client(get_response=resp))

    r = client.get("/experiments/etr_missing")
    assert r.status_code == 400
    assert "not found" in r.json()["detail"].lower()


def test_get_experiment_parses_timestamps(monkeypatch, client):
    resp = _mock_httpx_response(200, FAKE_ENTRY)
    monkeypatch.setattr(eln_main, "_client_factory", lambda: _mock_async_client(get_response=resp))

    r = client.get("/experiments/etr_abc123")
    body = r.json()
    assert body["created_at"] == "2024-01-15T10:00:00Z"
    assert body["modified_at"] == "2024-01-16T08:30:00Z"


# --------------------------------------------------------------------------
# POST /query_runs
# --------------------------------------------------------------------------
def test_query_runs_happy_path(monkeypatch, client):
    resp = _mock_httpx_response(200, FAKE_ENTRIES_RESPONSE)
    monkeypatch.setattr(eln_main, "_client_factory", lambda: _mock_async_client(get_response=resp))

    r = client.post("/query_runs", json={"project_id": "proj_001", "limit": 10})
    assert r.status_code == 200
    body = r.json()
    assert len(body["entries"]) == 1
    assert body["entries"][0]["id"] == "etr_abc123"
    assert body["next_page_token"] is None


def test_query_runs_limit_over_200_rejected(client):
    r = client.post("/query_runs", json={"limit": 999})
    assert r.status_code == 422


def test_query_runs_filters_passed(monkeypatch, client):
    mock_client = mock.AsyncMock()
    mock_client.get.return_value = _mock_httpx_response(200, FAKE_ENTRIES_RESPONSE)

    class _Ctx:
        async def __aenter__(self):
            return mock_client
        async def __aexit__(self, *_):
            pass

    monkeypatch.setattr(eln_main, "_client_factory", lambda: _Ctx())

    client.post(
        "/query_runs",
        json={"project_id": "proj_X", "schema_id": "sch_Y", "since": "2024-01-01T00:00:00Z"},
    )
    call_kwargs = mock_client.get.call_args
    params = call_kwargs[1].get("params", call_kwargs[0][1] if len(call_kwargs[0]) > 1 else {})
    assert params.get("projectId") == "proj_X"
    assert params.get("schemaId") == "sch_Y"
    assert ">2024-01-01T00:00:00Z" in params.get("modifiedAt", "")


def test_query_runs_empty_result(monkeypatch, client):
    resp = _mock_httpx_response(200, {"entries": [], "nextToken": None})
    monkeypatch.setattr(eln_main, "_client_factory", lambda: _mock_async_client(get_response=resp))

    r = client.post("/query_runs", json={})
    assert r.status_code == 200
    assert r.json()["entries"] == []
