"""Tests for services/common/config_registry.py.

Phase 2 of the configuration concept (Initiative 1, Python mirror).

Live DB tests are deferred to integration tier; these mock psycopg.connect
so the helper's caching, scope resolution, and fallback semantics can be
verified in isolation.
"""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import pytest

from services.common.config_registry import ConfigContext, ConfigRegistry


# ---------------------------------------------------------------------------
# Mocked psycopg.connect that pretends to be a config_settings backend
# ---------------------------------------------------------------------------


class FakeConn:
    def __init__(self, values: dict[tuple, object]) -> None:
        self._values = values
        self.call_count = 0

    def cursor(self):  # noqa: D401
        return self

    def execute(self, sql: str, params: tuple) -> None:
        self.call_count += 1
        # params are (key, user, project, org)
        self._last_value = self._values.get(tuple(params))

    def fetchone(self):
        return (self._last_value,)

    # Context-manager protocol — psycopg.Connection / Cursor are CMs.
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def patched_connect(*, values: dict[tuple, object]) -> object:
    fake = FakeConn(values)
    return patch(
        "services.common.config_registry.psycopg.connect",
        return_value=fake,
    ), fake


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_get_returns_default_when_row_absent() -> None:
    cm, fake = patched_connect(values={})
    with cm:
        reg = ConfigRegistry("dsn-stub")
        assert reg.get("missing.key", "fallback") == "fallback"
    # One DB call made, then "fallback" returned.
    assert fake.call_count == 1


def test_get_returns_resolved_value_at_global_scope() -> None:
    cm, _ = patched_connect(
        values={("agent.max_active_skills", None, None, None): 16},
    )
    with cm:
        reg = ConfigRegistry("dsn-stub")
        assert reg.get("agent.max_active_skills", 8) == 16


def test_get_passes_user_project_org_context() -> None:
    cm, fake = patched_connect(
        values={("agent.budget", "alice", "p1", "acme"): 999},
    )
    with cm:
        reg = ConfigRegistry("dsn-stub")
        ctx = ConfigContext(user="alice", project="p1", org="acme")
        assert reg.get("agent.budget", 0, ctx) == 999
    assert fake.call_count == 1


def test_get_caches_within_ttl() -> None:
    cm, fake = patched_connect(
        values={("k", None, None, None): 42},
    )
    with cm:
        reg = ConfigRegistry("dsn-stub", ttl_seconds=60.0)
        for _ in range(3):
            assert reg.get("k", 0) == 42
    assert fake.call_count == 1, "second / third reads should be cache hits"


def test_invalidate_drops_one_key_only() -> None:
    cm, fake = patched_connect(
        values={
            ("k1", None, None, None): 1,
            ("k2", None, None, None): 2,
        },
    )
    with cm:
        reg = ConfigRegistry("dsn-stub")
        reg.get("k1", 0)
        reg.get("k2", 0)
        reg.invalidate("k1")
        reg.get("k1", 0)
        reg.get("k2", 0)
    assert fake.call_count == 3, "k1 re-fetched, k2 still cached"


def test_invalidate_no_arg_drops_everything() -> None:
    cm, fake = patched_connect(
        values={("k", None, None, None): 1},
    )
    with cm:
        reg = ConfigRegistry("dsn-stub")
        reg.get("k", 0)
        reg.invalidate()
        reg.get("k", 0)
    assert fake.call_count == 2


def test_get_int_falls_back_for_non_int() -> None:
    cm, _ = patched_connect(
        values={("k", None, None, None): "not a number"},
    )
    with cm:
        reg = ConfigRegistry("dsn-stub")
        assert reg.get_int("k", 7) == 7


def test_get_int_rejects_bool() -> None:
    # Subtle: bool is a subclass of int in Python; the helper rejects it.
    cm, _ = patched_connect(
        values={("k", None, None, None): True},
    )
    with cm:
        reg = ConfigRegistry("dsn-stub")
        assert reg.get_int("k", 9) == 9


def test_get_float_accepts_int_and_float() -> None:
    cm, _ = patched_connect(
        values={
            ("a", None, None, None): 3,
            ("b", None, None, None): 3.14,
        },
    )
    with cm:
        reg = ConfigRegistry("dsn-stub")
        assert reg.get_float("a", 0.0) == 3.0
        assert reg.get_float("b", 0.0) == pytest.approx(3.14)


def test_get_bool_only_accepts_real_bool() -> None:
    cm, _ = patched_connect(
        values={
            ("a", None, None, None): True,
            ("b", None, None, None): "true",
        },
    )
    with cm:
        reg = ConfigRegistry("dsn-stub")
        assert reg.get_bool("a", False) is True
        assert reg.get_bool("b", False) is False  # string, not bool


def test_get_string_falls_back_for_non_string() -> None:
    cm, _ = patched_connect(
        values={("k", None, None, None): 42},
    )
    with cm:
        reg = ConfigRegistry("dsn-stub")
        assert reg.get_string("k", "fallback") == "fallback"


def test_db_failure_returns_default_silently() -> None:
    """Connection errors should NOT propagate — workers must keep running."""
    import psycopg

    with patch(
        "services.common.config_registry.psycopg.connect",
        side_effect=psycopg.OperationalError("simulated outage"),
    ):
        reg = ConfigRegistry("dsn-stub")
        assert reg.get("k", "fallback") == "fallback"


def test_cache_expires_after_ttl() -> None:
    cm, fake = patched_connect(
        values={("k", None, None, None): 1},
    )
    with cm:
        reg = ConfigRegistry("dsn-stub", ttl_seconds=0.01)
        reg.get("k", 0)
        time.sleep(0.05)
        reg.get("k", 0)
    assert fake.call_count == 2
