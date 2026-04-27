"""Tests for scope enforcement in `create_app()`.

Scope checking is the second half of ADR 006 Layer 2: cycle 1 wired the
JWT-verification middleware that *extracts* scopes; cycle 2 enforces them.
A token minted with `mcp_kg:rw` scope must not be accepted by
`mcp_doc_fetcher` (which expects `mcp_doc_fetcher:fetch`) — otherwise a
compromised low-privilege scope = full fleet access.

Dev mode (the conftest default) skips the check so existing local-dev
flows keep working without minting scoped tokens.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.auth import sign_mcp_token

KEY = "test-signing-key-32-bytes-XXXXXX"


@pytest.fixture()
def enforced_env(monkeypatch: pytest.MonkeyPatch):
    """Flip the auth middleware into enforced mode for one test.

    The conftest sets MCP_AUTH_DEV_MODE=true at collection time so most
    tests skip auth entirely; this fixture overrides that for scope-
    enforcement tests by setting MCP_AUTH_REQUIRED=true (which takes
    precedence over the dev-mode default per `_require_or_skip`).
    """
    monkeypatch.setenv("MCP_AUTH_REQUIRED", "true")
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", KEY)
    yield


_SERVICE_NAME = "mcp-test"


def _app_with_scope(scope: str | None) -> TestClient:
    app = create_app(
        name=_SERVICE_NAME,
        version="0.1.0",
        log_level="WARNING",
        required_scope=scope,
    )

    @app.post("/echo")
    async def _echo(payload: dict) -> dict:
        return {"echo": payload}

    return TestClient(app)


def _bearer(scopes: list[str], *, audience: str | None = _SERVICE_NAME) -> dict[str, str]:
    """Build an Authorization header.

    `audience` defaults to the service name so the cycle-3 audience binding
    is satisfied. Pass `audience=None` to test the rejection path explicitly,
    or a different name to test cross-service replay.
    """
    token = sign_mcp_token(
        sandbox_id="sbx_test",
        user_entra_id="alice@corp.com",
        scopes=scopes,
        audience=audience,
        signing_key=KEY,
    )
    return {"Authorization": f"Bearer {token}"}


def test_request_with_required_scope_passes(enforced_env):
    client = _app_with_scope("mcp_kg:rw")
    r = client.post("/echo", json={"x": 1}, headers=_bearer(["mcp_kg:rw"]))
    assert r.status_code == 200
    assert r.json() == {"echo": {"x": 1}}


def test_request_missing_required_scope_is_403(enforced_env):
    client = _app_with_scope("mcp_kg:rw")
    r = client.post("/echo", json={"x": 1}, headers=_bearer(["mcp_doc_fetcher:fetch"]))
    assert r.status_code == 403
    body = r.json()
    assert body["error"] == "forbidden"
    assert "mcp_kg:rw" in body["detail"]


def test_request_with_no_required_scope_is_unrestricted(enforced_env):
    """create_app(required_scope=None) accepts any signed token."""
    client = _app_with_scope(None)
    r = client.post("/echo", json={"x": 1}, headers=_bearer([]))
    assert r.status_code == 200


def test_dev_mode_skips_scope_check(monkeypatch: pytest.MonkeyPatch):
    """When auth is in dev mode, scope mismatch is not enforced."""
    monkeypatch.setenv("MCP_AUTH_DEV_MODE", "true")
    monkeypatch.delenv("MCP_AUTH_REQUIRED", raising=False)
    client = _app_with_scope("mcp_kg:rw")
    # No Authorization header at all — accepted in dev mode regardless of scope.
    r = client.post("/echo", json={"x": 1})
    assert r.status_code == 200


def test_probes_are_exempt_from_scope_check(enforced_env):
    """/healthz and /readyz must remain reachable without a token."""
    client = _app_with_scope("mcp_kg:rw")
    r = client.get("/healthz")
    assert r.status_code == 200
    r = client.get("/readyz")
    assert r.status_code == 200


def test_token_with_multiple_scopes_passes_when_required_present(enforced_env):
    client = _app_with_scope("mcp_doc_fetcher:fetch")
    r = client.post(
        "/echo",
        json={"x": 1},
        headers=_bearer(["mcp_kg:rw", "mcp_doc_fetcher:fetch", "mcp_chemprop:invoke"]),
    )
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# Cycle-3: audience binding closes per-service replay
# ---------------------------------------------------------------------------


def test_token_without_aud_is_rejected_in_enforced_mode(enforced_env):
    """A token minted before cycle-3 (no aud) must not be accepted.

    Otherwise an attacker who possesses an old token could replay it
    against a new deployment that expects aud-binding.
    """
    client = _app_with_scope("mcp_kg:rw")
    r = client.post(
        "/echo",
        json={"x": 1},
        headers=_bearer(["mcp_kg:rw"], audience=None),
    )
    assert r.status_code == 401
    assert "aud" in r.json()["detail"].lower()


def test_token_with_wrong_aud_is_rejected(enforced_env):
    """A `mcp_kg:rw` token with aud=mcp-kg-blue must not be accepted by mcp-test."""
    client = _app_with_scope("mcp_kg:rw")
    r = client.post(
        "/echo",
        json={"x": 1},
        headers=_bearer(["mcp_kg:rw"], audience="mcp-kg-blue"),
    )
    assert r.status_code == 401
    assert "audience" in r.json()["detail"].lower() or "aud" in r.json()["detail"].lower()


def test_dev_mode_accepts_wrong_scope_and_wrong_aud(monkeypatch: pytest.MonkeyPatch):
    """The reviewer's gap: dev mode must skip BOTH scope AND aud checks.

    A future refactor that accidentally enforces either in dev mode would
    break local-dev workflows; this test pins the contract.
    """
    monkeypatch.setenv("MCP_AUTH_DEV_MODE", "true")
    monkeypatch.delenv("MCP_AUTH_REQUIRED", raising=False)
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", KEY)
    client = _app_with_scope("mcp_kg:rw")
    # Wrong scope AND wrong aud — should still be allowed in dev mode.
    r = client.post(
        "/echo",
        json={"x": 1},
        headers=_bearer(["mcp_doc_fetcher:fetch"], audience="some-other-service"),
    )
    assert r.status_code == 200


def test_create_app_refuses_scope_disagreement_with_catalog():
    """If a service passes required_scope= that disagrees with SERVICE_SCOPES,
    fail at startup, not silently in production."""
    from services.mcp_tools.common.app import create_app

    with pytest.raises(RuntimeError, match="reconcile"):
        create_app(
            name="mcp-rdkit",  # in SERVICE_SCOPES catalog
            version="0.1.0",
            required_scope="wrong:scope",  # disagrees
        )
