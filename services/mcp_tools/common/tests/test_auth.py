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
