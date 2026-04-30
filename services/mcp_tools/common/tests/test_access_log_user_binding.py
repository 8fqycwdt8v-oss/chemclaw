"""Verifies the cycle-2 fix for the access-log user binding.

The original middleware order had `mcp_auth_middleware` reset the
user token in its own try/finally — and FastAPI unwinds inner-first,
so the reset fired BEFORE `add_request_id`'s access log emit ran.
Every authenticated request emitted `event=http_request` with no
`user` field, breaking per-user Loki queries.

The fix: bind user without resetting; let the outer
`add_request_id` reset on its `request_id` token cascade and clear
the contextvar in one shot. This test exercises the middleware
directly with a verified token + claims and asserts the access log
record DOES carry the user field.
"""

from __future__ import annotations

import json
import logging
import os
from io import StringIO

import pytest
from fastapi.testclient import TestClient

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.auth import sign_mcp_token


SIGNING_KEY = "test-signing-key-32-bytes-XXXXXXXXXX"


@pytest.fixture(autouse=True)
def _set_signing_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", SIGNING_KEY)
    # Force enforced auth — dev-mode would short-circuit before user binding.
    monkeypatch.setenv("MCP_AUTH_REQUIRED", "true")
    monkeypatch.delenv("MCP_AUTH_DEV_MODE", raising=False)
    monkeypatch.setenv("LOG_FORMAT", "json")


def _swap_handler_stream() -> StringIO:
    buf = StringIO()
    root = logging.getLogger()
    handler = root.handlers[0]
    handler.stream = buf  # type: ignore[attr-defined]
    return buf


def test_access_log_carries_user_for_authenticated_request() -> None:
    app = create_app(name="mcp-test-access-log", version="0.0.1", required_scope="")

    @app.get("/probe")
    async def probe() -> dict[str, str]:
        # Emit a handler-level log line — it should also carry the user.
        logging.getLogger("test").info("inside handler")
        return {"ok": "yes"}

    buf = _swap_handler_stream()

    token = sign_mcp_token(
        sandbox_id="sbx-001",
        user_entra_id="alice@example.com",
        scopes=[],
        signing_key=SIGNING_KEY,
        audience="mcp-test-access-log",
    )

    client = TestClient(app)
    resp = client.get("/probe", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200

    lines = [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]
    # Every record produced during the request must carry the hashed user.
    request_lines = [r for r in lines if r.get("request_id")]
    assert request_lines, "no records carried request_id"

    # The access-log record specifically — historically broken pre-fix.
    access_lines = [r for r in request_lines if r.get("event") == "http_request"]
    assert access_lines, "no http_request access record emitted"
    access = access_lines[-1]
    assert access.get("user"), (
        "access log lost the user field — middleware reset cascade is broken; "
        f"got record: {access}"
    )
    # The hash is the 16-hex-char salted prefix; must NOT be the raw email.
    assert access["user"] != "alice@example.com"
    assert "alice" not in access["user"]

    # Handler-emitted log lines also carry the user.
    handler_lines = [r for r in request_lines if r.get("message") == "inside handler"]
    assert handler_lines, "handler log not captured"
    assert handler_lines[0].get("user")
