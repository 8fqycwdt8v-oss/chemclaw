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
    global _salt
    if _salt is not None:
        return _salt
    from_env = (os.getenv("LOG_USER_SALT") or "").strip()
    _salt = from_env if from_env else DEFAULT_DEV_SALT
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
