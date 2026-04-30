"""One-way hash for user identifiers in logs.

Mirrors `services/agent-claw/src/observability/user-hash.ts`. Both sides
share the env var name (LOG_USER_SALT) so an operator sets the salt once
per cluster and TS / Python correlations line up.

Why hashed: `userEntraId` is PII (looks like an email or a GUID). Raw
values must never reach Loki / Grafana / log archives. The hash is salted
+ truncated to 16 hex chars (64 bits), enough for cross-service
correlation without giving an attacker a useful brute-force surface
(sha256 + 64-bit prefix + per-deploy salt = ~2^64 work to recover).
"""

from __future__ import annotations

import hashlib
import os

DEFAULT_DEV_SALT = "chemclaw-dev-salt-not-secret"

_salt: str | None = None


def _get_salt() -> str:
    """Resolve the salt with fail-closed semantics in production.

    When LOG_USER_SALT is unset:
      - dev mode (CHEMCLAW_DEV_MODE=true OR no production indicator):
        fall back to the public dev salt.
      - production: raise. Without this, the hash is cryptographically
        useless — an attacker with log access can pre-compute
        sha256("chemclaw-dev-salt-not-secret:" + email) against any
        public email list and de-anonymise users in seconds.
    """
    global _salt
    if _salt is not None:
        return _salt
    from_env = (os.getenv("LOG_USER_SALT") or "").strip()
    if from_env:
        _salt = from_env
        return _salt
    is_dev = (
        os.getenv("CHEMCLAW_DEV_MODE", "").lower() == "true"
        or os.getenv("MCP_AUTH_DEV_MODE", "").lower() == "true"
        or os.getenv("PYTEST_CURRENT_TEST") is not None
    )
    if not is_dev:
        raise RuntimeError(
            "LOG_USER_SALT is required outside dev mode (set CHEMCLAW_DEV_MODE=true "
            "for local dev, or supply a real salt in production). The default "
            "salt is public — without a real salt the 16-hex-char hash "
            "trivially de-anonymises users via rainbow-table lookup."
        )
    _salt = DEFAULT_DEV_SALT
    return _salt


def hash_user(user_entra_id: str | None) -> str:
    """Return a 16-hex-char salted prefix of sha256(salt:user).

    Returns the empty string for empty / None input so log call sites can
    pass the raw field through without null-checks.
    """
    if not user_entra_id:
        return ""
    h = hashlib.sha256()
    h.update(_get_salt().encode("utf-8"))
    h.update(b":")
    h.update(user_entra_id.encode("utf-8"))
    return h.hexdigest()[:16]


def reset_user_hash_for_tests() -> None:
    """Drop the cached salt — tests changing LOG_USER_SALT call this."""
    global _salt
    _salt = None
