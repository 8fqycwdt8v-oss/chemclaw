"""MCP service Bearer-token authentication (ADR 006 partial).

Verifies HS256 JWTs minted by the agent before dispatching tool requests.
Tokens carry the calling user's Entra-ID, the sandbox ID (if the call
originates from an E2B sandbox), and a list of allowed scopes.

Layered defense:
  - Direct calls from outside the cluster need to know the signing key.
  - Calls from the E2B sandbox carry a per-sandbox token with a 5-minute TTL,
    so even if the sandbox is compromised the bearer can't long-outlive the
    sandbox session.
  - MCP services log the (sandbox_id, user) on every authenticated call.

Key management:
  MCP_AUTH_SIGNING_KEY environment variable. Production deploys load this
  from a Kubernetes secret shared between agent and MCP services. Dev mode
  (MCP_AUTH_REQUIRED=false) skips verification with a one-line warning so
  local-dev, smoke tests, and existing pytest suites continue to work.

This module is dependency-free besides the Python stdlib so MCP services
don't need to add a JWT library.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import Header, HTTPException, status

log = logging.getLogger("mcp.auth")


@dataclass(frozen=True)
class McpTokenClaims:
    """Verified token claims returned by `verify_mcp_token`."""

    sub: str  # subject — usually the sandbox_id
    user: str  # user_entra_id — for RLS scoping inside the called tool
    scopes: tuple[str, ...]
    exp: int  # unix-timestamp
    aud: str | None = None  # target service identifier (cycle 3 — ADR 006 Layer 2)


class McpAuthError(Exception):
    """Raised on any verification failure. Mapped to 401 by the FastAPI dep."""


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def sign_mcp_token(
    *,
    sandbox_id: str,
    user_entra_id: str,
    scopes: list[str] | tuple[str, ...],
    audience: str | None = None,
    ttl_seconds: int = 300,
    signing_key: str | None = None,
    now: int | None = None,
) -> str:
    """Mint an HS256-signed JWT for the agent → MCP-service path.

    `signing_key` defaults to the MCP_AUTH_SIGNING_KEY env var; in production
    that comes from a Kubernetes secret. `now` is overridable for tests.

    `audience` (added cycle 3) binds the token to a single target MCP service;
    the verifier rejects tokens whose `aud` claim doesn't match the calling
    service's name. Without it, a `mcp_kg:rw` token could be replayed against
    a peer mcp-kg deployment (blue/green or per-tenant). Pass the destination
    service name (e.g. "mcp-rdkit") here.
    """
    # Strip whitespace before either guard so a misconfigured deploy with
    # MCP_AUTH_SIGNING_KEY=" " cannot mint or verify tokens with a key
    # whose effective length is zero. Length check uses the stripped key
    # so "32 spaces" is rejected as too short.
    key = (signing_key or os.environ.get("MCP_AUTH_SIGNING_KEY", "")).strip()
    if not key:
        raise McpAuthError(
            "MCP_AUTH_SIGNING_KEY is empty; refusing to mint an unsigned token"
        )
    # HS256 minimum: 32 chars (~256 bits). Refusing weak keys at sign time
    # catches misconfigured deploys before they ship a token an attacker
    # could feasibly brute-force.
    if len(key) < 32:
        raise McpAuthError(
            f"MCP_AUTH_SIGNING_KEY too short ({len(key)} chars after stripping "
            "whitespace); HS256 requires >=32 characters of entropy"
        )
    issued_at = now if now is not None else int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload: dict[str, Any] = {
        "sub": sandbox_id,
        "user": user_entra_id,
        "scopes": list(scopes),
        "exp": issued_at + ttl_seconds,
        "iat": issued_at,
    }
    if audience is not None:
        payload["aud"] = audience
    h = _b64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    p = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{h}.{p}".encode("ascii")
    sig = hmac.new(key.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return f"{h}.{p}.{_b64url_encode(sig)}"


def verify_mcp_token(
    token: str,
    *,
    signing_key: str | None = None,
    expected_audience: str | None = None,
    now: int | None = None,
) -> McpTokenClaims:
    """Validate an HS256 JWT and return its claims.

    Raises `McpAuthError` on any failure: malformed, bad signature, expired,
    audience mismatch, missing required field. Constant-time signature
    comparison.

    `expected_audience` (added cycle 3) closes per-service replay: pass the
    calling service's own name (e.g. "mcp-rdkit") and the token will be
    rejected if its `aud` claim doesn't match. Tokens with no `aud` claim
    are accepted only when `expected_audience` is None — in enforced mode
    every service should pass this argument.
    """
    # Mirror sign_mcp_token's whitespace handling so a misconfigured key
    # cannot pass verification either.
    key = (signing_key or os.environ.get("MCP_AUTH_SIGNING_KEY", "")).strip()
    if not key:
        raise McpAuthError("MCP_AUTH_SIGNING_KEY is empty; cannot verify token")

    parts = token.split(".")
    if len(parts) != 3:
        raise McpAuthError("malformed token: not three dot-separated parts")
    h_b64, p_b64, sig_b64 = parts

    signing_input = f"{h_b64}.{p_b64}".encode("ascii")
    expected_sig = hmac.new(key.encode("utf-8"), signing_input, hashlib.sha256).digest()
    try:
        actual_sig = _b64url_decode(sig_b64)
    except Exception as exc:  # noqa: BLE001
        raise McpAuthError(f"malformed signature: {exc}") from exc
    if not hmac.compare_digest(expected_sig, actual_sig):
        raise McpAuthError("bad signature")

    try:
        header = json.loads(_b64url_decode(h_b64))
        payload = json.loads(_b64url_decode(p_b64))
    except Exception as exc:  # noqa: BLE001
        raise McpAuthError(f"malformed JSON: {exc}") from exc

    if header.get("alg") != "HS256":
        raise McpAuthError(f"unexpected alg: {header.get('alg')}")

    exp = payload.get("exp")
    if not isinstance(exp, int):
        raise McpAuthError("missing or non-integer exp")
    current = now if now is not None else int(time.time())
    if exp < current:
        raise McpAuthError(f"token expired at {exp} (now={current})")

    sub = payload.get("sub")
    user = payload.get("user")
    scopes = payload.get("scopes")
    if not isinstance(sub, str) or not isinstance(user, str):
        raise McpAuthError("missing sub or user")
    if not isinstance(scopes, list) or not all(isinstance(s, str) for s in scopes):
        raise McpAuthError("scopes must be a list of strings")

    aud_raw = payload.get("aud")
    aud: str | None
    if aud_raw is None:
        aud = None
    elif isinstance(aud_raw, str):
        aud = aud_raw
    else:
        raise McpAuthError(f"aud must be a string if present, got {type(aud_raw).__name__}")

    if expected_audience is not None:
        if aud is None:
            raise McpAuthError(
                f"token missing aud claim; this service requires aud={expected_audience!r}"
            )
        if aud != expected_audience:
            raise McpAuthError(
                f"audience mismatch: token aud={aud!r}, expected={expected_audience!r}"
            )

    return McpTokenClaims(sub=sub, user=user, scopes=tuple(scopes), exp=exp, aud=aud)


def _require_or_skip() -> bool:
    """Whether to enforce verification on incoming MCP requests.

    Fails closed by default — production deploys that forget to set the
    auth env explicitly will REJECT unsigned requests rather than silently
    accept them (the prior default was a quiet fail-OPEN with only a log
    warning, which is the wrong default for a network-reachable service).

    Local dev / CI opts out via either:
      - MCP_AUTH_REQUIRED=false  (legacy explicit; still honored)
      - MCP_AUTH_DEV_MODE=true   (preferred — declares intent, not policy)
    """
    raw = os.environ.get("MCP_AUTH_REQUIRED")
    dev_mode = os.environ.get("MCP_AUTH_DEV_MODE", "").strip().lower() == "true"
    if raw is None:
        # Unset → enforce. Dev mode flag is the explicit opt-out.
        return not dev_mode
    return raw.strip().lower() == "true"


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------


async def require_mcp_token(
    authorization: Annotated[str | None, Header()] = None,
) -> McpTokenClaims | None:
    """FastAPI dependency that validates the Authorization header.

    In enforced mode (MCP_AUTH_REQUIRED=true), missing/invalid token yields a
    401. In dev mode, returns None and emits a single warning so callers can
    distinguish "no token" from "valid token" (and continue to work without
    one). Routes that require auth always check for a non-None return.
    """
    enforce = _require_or_skip()
    if not authorization:
        if enforce:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": "unauthenticated", "detail": "missing Authorization header"},
                headers={"WWW-Authenticate": "Bearer"},
            )
        return None

    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        if enforce:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": "unauthenticated", "detail": "expected `Authorization: Bearer <token>`"},
                headers={"WWW-Authenticate": "Bearer"},
            )
        return None

    token = parts[1].strip()
    try:
        claims = verify_mcp_token(token)
    except McpAuthError as exc:
        if enforce:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": "unauthenticated", "detail": str(exc)},
                headers={"WWW-Authenticate": "Bearer"},
            ) from exc
        log.warning("MCP token verification failed (dev mode, allowing): %s", exc)
        return None

    return claims
