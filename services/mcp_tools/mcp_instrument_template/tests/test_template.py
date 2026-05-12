"""Smoke tests for the instrument-MCP skeleton.

The skeleton intentionally returns 501 from every content endpoint;
these tests verify the routes mount correctly, validation runs, and
the template is wireable end-to-end before vendor logic is added.
Replace these tests when you copy the directory to a real adapter.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from services.mcp_tools.mcp_instrument_template.main import app


def test_healthz_works_via_inherited_create_app():
    client = TestClient(app)
    resp = client.get("/healthz")
    assert resp.status_code == 200


def test_get_run_invalid_id_returns_400():
    client = TestClient(app)
    # Forbidden character (space) in the run_id — the regex rejects this
    # before any upstream URL is constructed. URL-encoded slashes don't
    # work as a test here because FastAPI path matching unwraps them and
    # returns 404 before the route fires.
    resp = client.get("/run/has%20space")
    assert resp.status_code == 400


def test_get_run_valid_id_returns_501_with_explanation():
    # Skeleton returns 501 with a body that explains where to wire the
    # real client. This is the contract that proves the template is
    # the runnable scaffold the README describes.
    client = TestClient(app)
    resp = client.get("/run/RUN-2026-001")
    assert resp.status_code == 501
    body = resp.json()
    # The MCP common app may flatten HTTPException detail dicts to a
    # JSON-stringified payload depending on FastAPI version; tolerate
    # both shapes by stringifying.
    detail_blob = repr(body)
    assert "not_implemented" in detail_blob
    assert "_fetch_run" in detail_blob


def test_search_runs_returns_501_with_explanation():
    client = TestClient(app)
    resp = client.post("/search_runs", json={})
    assert resp.status_code == 501
    detail_blob = repr(resp.json())
    assert "not_implemented" in detail_blob


def test_search_runs_validates_pagination():
    client = TestClient(app)
    # page < 1 should be rejected by Pydantic before the route fires.
    resp = client.post("/search_runs", json={"page": 0})
    assert resp.status_code == 422
