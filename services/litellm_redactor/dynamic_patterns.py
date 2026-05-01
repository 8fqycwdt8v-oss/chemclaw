"""DB-backed redaction-pattern loader.

Phase 3 of the configuration concept (Initiative 4).

The hardcoded patterns in ``redaction.py`` remain as a baseline; this loader
fetches additional patterns from the ``redaction_patterns`` table and merges
them in with a 60s cache. Tenant-scoped (org=...) patterns are loaded but
not yet applied per-call — the LiteLLM gateway doesn't have the caller's
org context natively, so the global-scope rows are the only ones consumed
today. Future work: thread org via a custom HTTP header.

Safety rails (defence in depth on top of the DB CHECK constraints):
    * length(pattern_regex) ≤ 200
    * try/except re.compile — invalid patterns are skipped + logged
    * is_pattern_safe() refuses unbounded `.*` / `.+` / `\\S+` constructs
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from dataclasses import dataclass

import psycopg

logger = logging.getLogger(__name__)

_CACHE_TTL_SECONDS = 60.0
_MAX_PATTERN_LEN = 200

# Forbidden constructs — bounded version of catastrophic-backtracking guard.
# We accept '.*?' lazy quantifier with a length-bounded follow (keeping it
# simple for now) by REJECTING any '.*' or '.+' that's not immediately
# followed by '?' AND a `{n,m}` upper bound. Same for `\S+` / `\w+` etc.
_UNBOUNDED_QUANT = re.compile(
    r"(?<!\\)(?:\.\*|\.\+|\\S\+|\\w\+|\\d\+|\\D\+|\\W\+)(?!\?\{)"
)


@dataclass(frozen=True)
class DynamicPattern:
    category: str
    pattern: re.Pattern[str]
    scope: str          # 'global' or 'org'
    scope_id: str       # '' for global


def is_pattern_safe(raw: str) -> tuple[bool, str | None]:
    """Returns (ok, reason_if_not).

    Rejects pathological regexes — first defence is the DB CHECK on length;
    this is the second.
    """
    if len(raw) > _MAX_PATTERN_LEN:
        return False, f"pattern length {len(raw)} > {_MAX_PATTERN_LEN}"
    if _UNBOUNDED_QUANT.search(raw):
        return False, "unbounded quantifier (use bounded {n,m} form)"
    try:
        re.compile(raw)
    except re.error as exc:
        return False, f"re.compile failed: {exc}"
    return True, None


class DynamicPatternLoader:
    """Caches DB-loaded patterns with a TTL, refreshes on miss."""

    def __init__(self, dsn: str | None = None, ttl_seconds: float = _CACHE_TTL_SECONDS) -> None:
        self._dsn = dsn or os.environ.get("REDACTOR_PG_DSN")
        self._ttl = ttl_seconds
        self._lock = threading.Lock()
        self._cache: list[DynamicPattern] = []
        self._cache_at: float = 0.0

    def get_patterns(self) -> list[DynamicPattern]:
        """Return all currently-applicable patterns. TTL-cached."""
        now = time.monotonic()
        with self._lock:
            if self._cache_at and now - self._cache_at < self._ttl:
                return list(self._cache)

        loaded = self._fetch_from_db()
        with self._lock:
            self._cache = loaded
            self._cache_at = now
        return list(loaded)

    def invalidate(self) -> None:
        with self._lock:
            self._cache_at = 0.0

    def _fetch_from_db(self) -> list[DynamicPattern]:
        if not self._dsn:
            return []
        try:
            with psycopg.connect(self._dsn, autocommit=True, connect_timeout=5) as conn:
                with conn.cursor() as cur:
                    # The redactor uses chemclaw_service-equivalent perms
                    # (no per-user RLS context). For tests / dev, a system
                    # sentinel keeps the FORCE-RLS gate happy.
                    cur.execute(
                        "SELECT set_config('app.current_user_entra_id', %s, true)",
                        ("__redactor__",),
                    )
                    cur.execute(
                        """
                        SELECT category, pattern_regex, flags_re_i, scope, scope_id
                          FROM redaction_patterns
                         WHERE enabled = TRUE
                        """
                    )
                    rows = cur.fetchall()
        except (psycopg.OperationalError, psycopg.DatabaseError) as exc:
            logger.warning("redactor: DB unavailable, skipping dynamic patterns: %s", exc)
            return []

        out: list[DynamicPattern] = []
        for category, raw, flag_i, scope, scope_id in rows:
            ok, why = is_pattern_safe(raw)
            if not ok:
                logger.warning(
                    "redactor: skipping unsafe pattern (category=%s, scope=%s): %s",
                    category,
                    scope,
                    why,
                )
                continue
            flags = re.IGNORECASE if flag_i else 0
            try:
                compiled = re.compile(raw, flags)
            except re.error as exc:
                logger.warning("redactor: re.compile failed for %s/%s: %s", category, scope, exc)
                continue
            out.append(
                DynamicPattern(
                    category=category,
                    pattern=compiled,
                    scope=scope,
                    scope_id=scope_id,
                )
            )
        return out


# Process-wide singleton; set up by the LiteLLM callback at import time.
_loader: DynamicPatternLoader | None = None


def get_loader() -> DynamicPatternLoader:
    global _loader
    if _loader is None:
        _loader = DynamicPatternLoader()
    return _loader


def set_loader(loader: DynamicPatternLoader) -> None:
    """Used by tests to install a stubbed loader."""
    global _loader
    _loader = loader
