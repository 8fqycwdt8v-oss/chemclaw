"""Python mirror of services/agent-claw/src/config/registry.ts.

Phase 2 of the configuration concept (Initiative 1).

Scoped (user > project > org > global) key/value reader backed by the
config_settings Postgres table. 60s in-process cache; thread-safe.

Used by Python services (gepa_runner, skill_promoter, session_reanimator,
projectors) to replace hardcoded constants with admin-tunable values.

Hardcoded fallback ALWAYS survives: the table being empty or unreachable
returns the caller's default rather than raising. This means a fresh
deployment still works before the migration runs and an outage in the
DB doesn't take down a worker.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Optional

import psycopg

logger = logging.getLogger(__name__)

_DEFAULT_TTL_SECONDS = 60.0


@dataclass(frozen=True)
class ConfigContext:
    user: Optional[str] = None
    project: Optional[str] = None
    org: Optional[str] = None

    def cache_key(self, key: str) -> str:
        return f"{key} {self.user or ''} {self.project or ''} {self.org or ''}"


class ConfigRegistry:
    """Read-only scoped config registry with TTL cache.

    The connection is held by the caller (via a `dsn` string passed in) and
    a fresh psycopg connection is opened per fetch. This keeps the helper
    independent of the consumer service's pool / engine choice — workers
    that already have a long-lived connection can subclass and override
    `_fetch_value()` to reuse it.
    """

    def __init__(self, dsn: str, ttl_seconds: float = _DEFAULT_TTL_SECONDS) -> None:
        self._dsn = dsn
        self._ttl = ttl_seconds
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[float, Any]] = {}

    def get(
        self,
        key: str,
        default: Any,
        ctx: ConfigContext = ConfigContext(),
    ) -> Any:
        """Return the resolved value for `key` at `ctx`, or `default`."""
        ck = ctx.cache_key(key)
        now = time.monotonic()
        with self._lock:
            cached = self._cache.get(ck)
            if cached is not None and now - cached[0] < self._ttl:
                value = cached[1]
                return default if value is None else value

        value = self._fetch_value(key, ctx)
        with self._lock:
            self._cache[ck] = (now, value)
        return default if value is None else value

    def get_int(self, key: str, default: int, ctx: ConfigContext = ConfigContext()) -> int:
        v = self.get(key, default, ctx)
        if isinstance(v, bool):
            # bool is a subclass of int; reject explicitly
            return default
        if isinstance(v, int):
            return v
        if isinstance(v, float) and v.is_integer():
            return int(v)
        return default

    def get_float(self, key: str, default: float, ctx: ConfigContext = ConfigContext()) -> float:
        v = self.get(key, default, ctx)
        if isinstance(v, bool):
            return default
        if isinstance(v, (int, float)):
            return float(v)
        return default

    def get_bool(self, key: str, default: bool, ctx: ConfigContext = ConfigContext()) -> bool:
        v = self.get(key, default, ctx)
        return v if isinstance(v, bool) else default

    def get_string(self, key: str, default: str, ctx: ConfigContext = ConfigContext()) -> str:
        v = self.get(key, default, ctx)
        return v if isinstance(v, str) else default

    def invalidate(self, key: Optional[str] = None) -> None:
        """Drop one cache entry (all scopes) or the whole cache."""
        with self._lock:
            if key is None:
                self._cache.clear()
                return
            prefix = f"{key} "
            for k in list(self._cache):
                if k.startswith(prefix):
                    del self._cache[k]

    # ------------------------------------------------------------------
    # Internal — overridable for tests / pool reuse
    # ------------------------------------------------------------------
    def _fetch_value(self, key: str, ctx: ConfigContext) -> Any:
        try:
            with psycopg.connect(self._dsn, autocommit=True, connect_timeout=5) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT resolve_config_setting(%s, %s, %s, %s)",
                        (key, ctx.user, ctx.project, ctx.org),
                    )
                    row = cur.fetchone()
                    return row[0] if row else None
        except (psycopg.OperationalError, psycopg.DatabaseError) as exc:
            logger.warning(
                "config_registry: fetch failed for key=%s ctx=%s err=%s — falling back to default",
                key,
                ctx,
                exc,
            )
            return None
