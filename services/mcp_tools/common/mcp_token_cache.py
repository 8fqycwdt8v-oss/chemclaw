"""Token cache for system-side services (queue worker, workflow engine)
that talk to MCP services.

Mirrors services/agent-claw/src/security/mcp-token-cache.ts. Every call to
`get_mcp_token(service)` returns either a cached short-lived JWT or mints
a fresh one via `services.mcp_tools.common.auth.sign_mcp_token`, scoped to
the right service via SERVICE_SCOPES.

Security model:
  * The signing key comes from MCP_AUTH_SIGNING_KEY (production: K8s secret).
  * Tokens are scoped to one MCP service (`aud` claim) so they cannot be
    replayed against a different MCP deployment.
  * Default TTL is 300 s; we refresh 60 s before expiry so an in-flight
    request never sees an expired token.
  * In dev mode (MCP_AUTH_REQUIRED unset / "false") we still mint tokens
    when the signing key is present — this keeps dev parity with prod.
    When the signing key is missing we skip the Authorization header
    entirely; MCP services in dev mode accept that.

The `subject` field defaults to a service-specific tag so audit trails on
the MCP side can tell who minted the token. Pass `user_entra_id="__system__"`
to flow into the system RLS context.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from threading import Lock

from services.mcp_tools.common.auth import McpAuthError, sign_mcp_token
from services.mcp_tools.common.scopes import SERVICE_SCOPES


log = logging.getLogger("mcp_token_cache")

DEFAULT_TTL_SECONDS = 300
REFRESH_BUFFER_SECONDS = 60


@dataclass
class _CachedToken:
    token: str
    expires_at: float  # epoch seconds


class McpTokenCache:
    """Per-process token cache keyed by (service, subject)."""

    def __init__(self, *, default_subject: str = "system") -> None:
        self._cache: dict[tuple[str, str], _CachedToken] = {}
        self._lock = Lock()
        self._default_subject = default_subject

    def get(
        self,
        *,
        service: str,
        user_entra_id: str = "__system__",
        subject: str | None = None,
    ) -> str | None:
        """Return a Bearer token for `service`, or None if no signing key.

        None is the dev-mode signal — callers should send the request without
        an Authorization header. MCP services in dev mode accept that.
        """
        signing_key = os.environ.get("MCP_AUTH_SIGNING_KEY", "").strip()
        if not signing_key:
            return None

        scope = SERVICE_SCOPES.get(service)
        if scope is None:
            log.warning(
                "no SERVICE_SCOPES entry for %s; minting an unscoped token",
                service,
                extra={"event": "mcp_token_no_scope", "service": service},
            )
            scope = ""

        sub = subject or self._default_subject
        cache_key = (service, f"{user_entra_id}|{sub}")

        now = time.time()
        with self._lock:
            cached = self._cache.get(cache_key)
            if cached is not None and cached.expires_at - REFRESH_BUFFER_SECONDS > now:
                return cached.token

            try:
                token = sign_mcp_token(
                    sandbox_id=sub,
                    user_entra_id=user_entra_id,
                    scopes=[scope] if scope else [],
                    audience=service,
                    ttl_seconds=DEFAULT_TTL_SECONDS,
                )
            except McpAuthError:
                # Re-raise — a misconfigured key is a deploy-time error.
                raise
            self._cache[cache_key] = _CachedToken(
                token=token,
                expires_at=now + DEFAULT_TTL_SECONDS,
            )
            return token

    def invalidate(self, *, service: str | None = None) -> None:
        with self._lock:
            if service is None:
                self._cache.clear()
                return
            for k in list(self._cache):
                if k[0] == service:
                    del self._cache[k]


# Module-level singleton — most services want one cache per process.
_DEFAULT_CACHE: McpTokenCache | None = None


def default_cache(default_subject: str = "system") -> McpTokenCache:
    global _DEFAULT_CACHE
    if _DEFAULT_CACHE is None:
        _DEFAULT_CACHE = McpTokenCache(default_subject=default_subject)
    return _DEFAULT_CACHE


def auth_headers(service: str, user_entra_id: str = "__system__") -> dict[str, str]:
    """Convenience: returns {Authorization: Bearer ...} or {} in dev mode."""
    token = default_cache().get(service=service, user_entra_id=user_entra_id)
    if token is None:
        return {}
    return {"Authorization": f"Bearer {token}"}
