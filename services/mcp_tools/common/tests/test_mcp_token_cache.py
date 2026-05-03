"""Tests for the system-side MCP token cache.

The cache must:
  * Return None when MCP_AUTH_SIGNING_KEY is unset (dev-mode signal).
  * Mint a JWT scoped to the destination service when the key is set.
  * Reuse the cached token until REFRESH_BUFFER_SECONDS before expiry.
  * Refresh when the cached token enters the buffer window.
  * Verify successfully via `verify_mcp_token`.
"""

from __future__ import annotations

import time

import pytest

from services.mcp_tools.common.auth import McpAuthError, verify_mcp_token
from services.mcp_tools.common.mcp_token_cache import (
    DEFAULT_TTL_SECONDS,
    REFRESH_BUFFER_SECONDS,
    McpTokenCache,
)


SIGNING_KEY = "test-signing-key-with-at-least-thirty-two-chars-and-then-some"


def test_get_returns_none_in_dev_mode(monkeypatch):
    monkeypatch.delenv("MCP_AUTH_SIGNING_KEY", raising=False)
    cache = McpTokenCache()
    assert cache.get(service="mcp-xtb") is None


def test_get_mints_when_key_present(monkeypatch):
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", SIGNING_KEY)
    cache = McpTokenCache(default_subject="test-subject")
    token = cache.get(service="mcp-xtb")
    assert token is not None
    claims = verify_mcp_token(
        token, signing_key=SIGNING_KEY, expected_audience="mcp-xtb",
    )
    assert claims.user == "__system__"
    assert "mcp_xtb:invoke" in claims.scopes


def test_get_reuses_cached_token(monkeypatch):
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", SIGNING_KEY)
    cache = McpTokenCache()
    a = cache.get(service="mcp-xtb")
    b = cache.get(service="mcp-xtb")
    assert a is not None
    assert a == b


def test_get_returns_distinct_tokens_per_service(monkeypatch):
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", SIGNING_KEY)
    cache = McpTokenCache()
    xtb = cache.get(service="mcp-xtb")
    crest = cache.get(service="mcp-crest")
    assert xtb is not None and crest is not None
    assert xtb != crest


def test_get_refreshes_when_inside_buffer(monkeypatch):
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", SIGNING_KEY)
    cache = McpTokenCache()
    a = cache.get(service="mcp-xtb")
    assert a is not None
    # Drop the cached entry to simulate the refresh-window codepath, then
    # advance time past the iat-second boundary so the new JWT carries a
    # different timestamp and therefore a different signature.
    key = ("mcp-xtb", "__system__|system")
    assert key in cache._cache
    cache._cache[key].__dict__["expires_at"] = time.time() + REFRESH_BUFFER_SECONDS - 1
    time.sleep(1.1)
    b = cache.get(service="mcp-xtb")
    assert b is not None
    assert a != b  # refreshed


def test_invalidate_drops_cached_tokens(monkeypatch):
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", SIGNING_KEY)
    cache = McpTokenCache()
    first = cache.get(service="mcp-xtb")
    assert first is not None
    cache.invalidate(service="mcp-xtb")
    # Sleep past the iat-second boundary so the new JWT differs even
    # though both calls succeed within the same wall-clock second.
    time.sleep(1.1)
    second = cache.get(service="mcp-xtb")
    assert second is not None
    assert first != second


def test_get_warns_on_unknown_service(monkeypatch):
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", SIGNING_KEY)
    cache = McpTokenCache()
    # This service is not in SERVICE_SCOPES; cache logs + mints unscoped.
    token = cache.get(service="mcp-totally-fictional")
    assert token is not None
    claims = verify_mcp_token(
        token, signing_key=SIGNING_KEY, expected_audience="mcp-totally-fictional",
    )
    # claims.scopes may be an empty list/tuple depending on version
    assert len(claims.scopes) == 0


def test_get_propagates_signing_key_errors(monkeypatch):
    # Set a too-short key so sign_mcp_token raises.
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", "short")
    cache = McpTokenCache()
    with pytest.raises(McpAuthError):
        cache.get(service="mcp-xtb")


def test_default_ttl_is_300_seconds():
    assert DEFAULT_TTL_SECONDS == 300
