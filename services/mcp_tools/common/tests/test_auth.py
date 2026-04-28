"""Tests for the MCP Bearer-token verifier (ADR 006 partial)."""

from __future__ import annotations

import json

import pytest

from services.mcp_tools.common.auth import (
    McpAuthError,
    sign_mcp_token,
    verify_mcp_token,
)

KEY = "test-signing-key-32-bytes-XXXXXX"


def test_round_trip_returns_claims():
    token = sign_mcp_token(
        sandbox_id="sbx_001",
        user_entra_id="alice@corp.com",
        scopes=["mcp_kg:read"],
        signing_key=KEY,
        now=1_700_000_000,
    )
    claims = verify_mcp_token(token, signing_key=KEY, now=1_700_000_000)
    assert claims.sub == "sbx_001"
    assert claims.user == "alice@corp.com"
    assert claims.scopes == ("mcp_kg:read",)
    assert claims.exp == 1_700_000_000 + 300


def test_rejects_wrong_key():
    token = sign_mcp_token(
        sandbox_id="sbx_001",
        user_entra_id="alice@corp.com",
        scopes=[],
        signing_key=KEY,
    )
    with pytest.raises(McpAuthError):
        verify_mcp_token(token, signing_key="different-key")


def test_rejects_expired_token():
    token = sign_mcp_token(
        sandbox_id="sbx_001",
        user_entra_id="alice@corp.com",
        scopes=[],
        ttl_seconds=60,
        signing_key=KEY,
        now=1_700_000_000,
    )
    with pytest.raises(McpAuthError, match="expired"):
        verify_mcp_token(token, signing_key=KEY, now=1_700_000_000 + 61)


def test_rejects_tampered_payload():
    import base64
    token = sign_mcp_token(
        sandbox_id="sbx_001",
        user_entra_id="alice@corp.com",
        scopes=["mcp_kg:read"],
        signing_key=KEY,
    )
    h, _p, s = token.split(".")
    tampered_payload = base64.urlsafe_b64encode(
        json.dumps(
            {
                "sub": "sbx_001",
                "user": "mallory@evil.com",
                "scopes": ["mcp_kg:read", "mcp_kg:write"],
                "exp": 9_999_999_999,
                "iat": 0,
            },
            separators=(",", ":"),
        ).encode("utf-8"),
    ).rstrip(b"=").decode("ascii")
    tampered = f"{h}.{tampered_payload}.{s}"
    with pytest.raises(McpAuthError, match="bad signature"):
        verify_mcp_token(tampered, signing_key=KEY)


def test_rejects_malformed_token():
    with pytest.raises(McpAuthError, match="malformed"):
        verify_mcp_token("not.a.jwt.at.all", signing_key=KEY)
    with pytest.raises(McpAuthError, match="malformed"):
        verify_mcp_token("only-one-part", signing_key=KEY)


def test_refuses_to_sign_without_key():
    with pytest.raises(McpAuthError, match="MCP_AUTH_SIGNING_KEY"):
        sign_mcp_token(
            sandbox_id="sbx_001",
            user_entra_id="alice@corp.com",
            scopes=[],
            signing_key="",
        )


def test_round_trip_with_long_ttl():
    # Smoke test that long-TTL claims survive round-trip.
    token = sign_mcp_token(
        sandbox_id="sbx_X",
        user_entra_id="alice@corp.com",
        scopes=["mcp_kg:read"],
        ttl_seconds=9_999_999_999 - 1_700_000_000,
        signing_key=KEY,
        now=1_700_000_000,
    )
    claims = verify_mcp_token(token, signing_key=KEY, now=1_700_000_000)
    assert claims.sub == "sbx_X"
    assert claims.user == "alice@corp.com"


# ---------------------------------------------------------------------------
# Phase 7 — fail-closed-by-default end-to-end tests
#
# These pin the runtime contract of the auth middleware (services/mcp_tools/
# common/app.py) under the four canonical env-var configurations. The
# helper functions in this file already cover the verifier layer in
# isolation; what's exercised here is the full request -> middleware ->
# route path so the regression we close with Phase 7 — a forgotten
# "if claims is None: deny" check leaving routes open — is impossible to
# re-introduce without breaking these tests.
#
# A `client` fixture is built per-test via _make_client(); each test
# constructs its TestClient AFTER monkeypatch has set the env so the
# middleware reads the right policy at request time.
# ---------------------------------------------------------------------------


@pytest.fixture()
def client_factory(monkeypatch):
    """Yield a builder that produces a TestClient for an /echo app.

    Tests configure env vars first, then call this to build a client so
    the middleware sees the patched env. The factory uses required_scope=""
    (the documented opt-out) so scope-mismatch tests can target the
    audience layer instead.
    """
    from fastapi.testclient import TestClient

    from services.mcp_tools.common.app import create_app

    def _make(name: str = "mcp-test", required_scope: str | None = "") -> TestClient:
        app = create_app(name=name, version="0.1.0", required_scope=required_scope)

        @app.post("/echo")
        async def _echo(payload: dict) -> dict:
            return {"echo": payload}

        return TestClient(app)

    return _make


def test_unsigned_request_rejected_by_default(monkeypatch, client_factory):
    """Without MCP_AUTH_SIGNING_KEY and without MCP_AUTH_DEV_MODE=true,
    unsigned requests must be rejected — fail-closed default.

    /healthz is exempt by design (k8s probes), so we hit the /echo route
    which goes through the auth middleware. This is the regression test
    that closes the audit gap: a forgotten None-check in a route must
    not be able to leak unsigned access.
    """
    monkeypatch.delenv("MCP_AUTH_SIGNING_KEY", raising=False)
    monkeypatch.delenv("MCP_AUTH_REQUIRED", raising=False)
    monkeypatch.delenv("MCP_AUTH_DEV_MODE", raising=False)
    client = client_factory()
    response = client.post("/echo", json={"x": 1})
    assert response.status_code in (401, 403), (
        f"unsigned request should be rejected by default; got {response.status_code}"
    )
    assert response.json()["error"] == "unauthenticated"


def test_unsigned_request_accepted_with_explicit_dev_mode(monkeypatch, client_factory):
    """With MCP_AUTH_DEV_MODE=true, unsigned requests are accepted with a warning.

    /healthz is always exempt; this exercises an auth-protected route to
    show the dev-mode opt-in actually flows through to /tools/* paths.
    """
    monkeypatch.delenv("MCP_AUTH_SIGNING_KEY", raising=False)
    monkeypatch.delenv("MCP_AUTH_REQUIRED", raising=False)
    monkeypatch.setenv("MCP_AUTH_DEV_MODE", "true")
    client = client_factory()
    response = client.post("/echo", json={"x": 1})
    assert response.status_code == 200
    assert response.json() == {"echo": {"x": 1}}
    # /healthz also reachable (always — probes are exempt regardless).
    assert client.get("/healthz").status_code == 200


def test_expired_token_rejected(monkeypatch, client_factory):
    """An HS256 token with exp in the past is rejected even with the right key.

    Belt-and-suspenders: the verifier-level test_rejects_expired_token
    above exercises this in isolation. This one exercises it through the
    full middleware so a future refactor that bypasses verify_mcp_token
    in the request path can't slip past.
    """
    import time

    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", KEY)
    monkeypatch.setenv("MCP_AUTH_REQUIRED", "true")
    monkeypatch.delenv("MCP_AUTH_DEV_MODE", raising=False)

    expired_token = sign_mcp_token(
        sandbox_id="sbx_001",
        user_entra_id="alice@corp.com",
        scopes=["mcp_kg:rw"],
        audience="mcp-test",
        ttl_seconds=60,
        signing_key=KEY,
        now=int(time.time()) - 3600,  # issued an hour ago, ttl 60s
    )
    client = client_factory()
    response = client.post(
        "/echo",
        json={"x": 1},
        headers={"Authorization": f"Bearer {expired_token}"},
    )
    assert response.status_code == 401
    assert "expired" in response.json()["detail"].lower()


def test_scope_mismatch_rejected(monkeypatch, client_factory):
    """A token with the wrong scope is rejected for endpoints requiring a different scope.

    Phase 7's primary concern is fail-closed on missing/invalid bearer.
    This test pins the cycle-2 scope check still fires in enforced mode,
    so a downgraded token for one service can't access another.
    """
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", KEY)
    monkeypatch.setenv("MCP_AUTH_REQUIRED", "true")
    monkeypatch.delenv("MCP_AUTH_DEV_MODE", raising=False)

    # Service requires "mcp_kg:rw" but token presents "mcp_doc_fetcher:fetch".
    client = client_factory(required_scope="mcp_kg:rw")
    wrong_scope_token = sign_mcp_token(
        sandbox_id="sbx_001",
        user_entra_id="alice@corp.com",
        scopes=["mcp_doc_fetcher:fetch"],
        audience="mcp-test",
        signing_key=KEY,
    )
    response = client.post(
        "/echo",
        json={"x": 1},
        headers={"Authorization": f"Bearer {wrong_scope_token}"},
    )
    assert response.status_code == 403
    body = response.json()
    assert body["error"] == "forbidden"
    assert "mcp_kg:rw" in body["detail"]
