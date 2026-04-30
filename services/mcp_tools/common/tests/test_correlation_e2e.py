"""End-to-end correlation test for MCP services.

Verifies the full chain inside a single Python process:

  HTTP request with X-Request-Id
    └─> add_request_id middleware binds it to LogContext
        └─> handler emits a log line + a 4xx error envelope
            └─> the same request_id appears in:
                  (a) the response's `x-request-id` header
                  (b) the JSON log record on stdout
                  (c) the error envelope returned in the response body

The cross-process variant (agent-claw -> MCP service -> projector ->
error_events row) requires the Docker stack and is exercised by
scripts/check-logs-pipeline.sh + the existing testcontainer integration
trio. This Python-only test is the deterministic CI gate.
"""

from __future__ import annotations

import json
import logging
import os
from io import StringIO

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from services.mcp_tools.common.app import create_app


@pytest.fixture
def captured_stdout() -> StringIO:
    """Replace the root JSON handler's stream with a StringIO so the
    test can assert on the exact bytes that would have hit stdout in
    production."""
    os.environ["LOG_FORMAT"] = "json"
    os.environ["MCP_AUTH_DEV_MODE"] = "true"
    yield_buf = StringIO()

    # Build the app FIRST so configure_logging runs and installs its
    # handler; THEN swap the handler's stream out for our buffer.
    yield (yield_buf, "deferred")


def test_request_id_flows_through_middleware_logs_and_envelope() -> None:
    os.environ["LOG_FORMAT"] = "json"
    os.environ["MCP_AUTH_DEV_MODE"] = "true"

    app = create_app(name="mcp-correlation-test", version="0.0.1", required_scope="")

    @app.get("/raise-bad-request")
    async def raise_bad_request() -> None:
        # Surfaces as a 400 envelope via the ValueError handler.
        logging.getLogger("test").info("about to raise")
        raise ValueError("invalid input from client")

    @app.get("/raise-http-404")
    async def raise_http_404() -> None:
        logging.getLogger("test").info("about to 404")
        raise HTTPException(status_code=404, detail="resource gone")

    # Swap the JSON handler's stream for a capture buffer.
    buf = StringIO()
    root = logging.getLogger()
    assert root.handlers, "configure_logging() didn't install a handler"
    root.handlers[0].stream = buf  # type: ignore[attr-defined]

    rid = "11111111-2222-3333-4444-555555555555"
    client = TestClient(app)

    # --- 400 path ---
    resp = client.get("/raise-bad-request", headers={"x-request-id": rid})
    assert resp.status_code == 400
    assert resp.headers.get("x-request-id") == rid

    body = resp.json()
    # The legacy envelope shape is preserved.
    assert body["error"] == "invalid_input"
    assert "invalid input from client" in body["detail"]

    # The captured log buffer should contain at least one record with the
    # same request_id and at least one access-log record.
    lines = [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]
    assert lines, "no log records captured"

    rid_lines = [r for r in lines if r.get("request_id") == rid]
    assert rid_lines, f"no log record carried request_id={rid}; got {lines}"

    # An access log record is present and carries status + duration_ms.
    access_lines = [r for r in lines if r.get("event") == "http_request"]
    assert access_lines, "no http_request access record emitted"
    assert access_lines[-1]["status"] == 400
    assert access_lines[-1]["duration_ms"] >= 0
    assert access_lines[-1]["request_id"] == rid

    # The handler's own log line must also carry the request_id.
    handler_lines = [r for r in lines if r.get("message") == "about to raise"]
    assert handler_lines, "handler log not captured"
    assert handler_lines[0]["request_id"] == rid

    # --- 404 path ---
    buf.truncate(0)
    buf.seek(0)
    resp = client.get("/raise-http-404", headers={"x-request-id": rid})
    assert resp.status_code == 404
    assert resp.headers.get("x-request-id") == rid

    body = resp.json()
    assert body["error"] == "not_found"
    assert "resource gone" in body["detail"]

    lines = [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]
    assert any(r.get("request_id") == rid for r in lines)


def test_request_id_is_generated_when_header_missing() -> None:
    """When no X-Request-Id is supplied, the middleware generates a
    UUID and surfaces it on the response header AND on every log
    record. The agent-claw side does the same — the round-trip
    correlation guarantee holds even for direct curl calls."""
    os.environ["LOG_FORMAT"] = "json"
    os.environ["MCP_AUTH_DEV_MODE"] = "true"
    app = create_app(name="mcp-correlation-test-2", version="0.0.1", required_scope="")

    @app.get("/no-rid")
    async def no_rid() -> dict[str, str]:
        return {"ok": "yes"}

    buf = StringIO()
    root = logging.getLogger()
    root.handlers[0].stream = buf  # type: ignore[attr-defined]

    client = TestClient(app)
    resp = client.get("/no-rid")
    assert resp.status_code == 200
    rid = resp.headers.get("x-request-id")
    assert rid, "middleware must generate a request_id when header is absent"
    assert len(rid) >= 16, "generated request_id should be UUID-shaped"

    lines = [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]
    assert any(r.get("request_id") == rid for r in lines), (
        "generated request_id should appear in every log record during the request"
    )
