"""Tests for services/optimizer/session_purger — TTL daemon.

All Postgres I/O is stubbed via AsyncMock; the daemon's Settings + SQL
shape are unit-tested in isolation.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.optimizer.session_purger.main import (
    Settings,
    _DELETE_EXPIRED_SQL,
    purge_once,
)


# ---------------------------------------------------------------------------
# Helpers — fake psycopg.AsyncConnection that the purger uses inside `async with`.
# ---------------------------------------------------------------------------


def _make_async_conn(rows: list[tuple[str, ...]]) -> Any:
    """Build a MagicMock that behaves like `await psycopg.AsyncConnection.connect(...)`.

    The purger uses two nested `async with` blocks (connection + cursor).
    Each level needs an async context manager that yields a mock with the
    right callables.
    """
    cursor = MagicMock()
    cursor.execute = AsyncMock(return_value=None)
    cursor.fetchall = AsyncMock(return_value=rows)
    cursor.__aenter__ = AsyncMock(return_value=cursor)
    cursor.__aexit__ = AsyncMock(return_value=None)

    conn = MagicMock()
    conn.cursor = MagicMock(return_value=cursor)
    conn.commit = AsyncMock(return_value=None)
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=None)

    # Track the cursor on the conn so tests can inspect it.
    conn._cursor = cursor
    return conn


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


class TestSettings:
    def test_defaults_match_documented_safe_values(self):
        s = Settings()
        assert s.poll_interval_seconds == 3600
        assert s.batch_size == 1000
        assert s.min_age_hours == 1
        # Must be the BYPASSRLS role so the daemon can DELETE across users.
        assert s.postgres_user == "chemclaw_service"

    def test_dsn_assembly(self):
        s = Settings(
            postgres_host="db",
            postgres_port=5433,
            postgres_db="cc",
            postgres_user="u",
            postgres_password="pw",
        )
        assert s.postgres_dsn == (
            "host=db port=5433 dbname=cc user=u password=pw"
        )


# ---------------------------------------------------------------------------
# SQL contract — the bounded-batch + min-age + cascade rely on the SQL shape.
# Asserting on the SQL string protects against accidental edits that change
# semantics (e.g. dropping FOR UPDATE SKIP LOCKED).
# ---------------------------------------------------------------------------


class TestDeleteSql:
    def test_uses_for_update_skip_locked_for_concurrent_replicas(self):
        assert "FOR UPDATE SKIP LOCKED" in _DELETE_EXPIRED_SQL

    def test_filters_by_expires_at_and_min_age(self):
        assert "expires_at < NOW()" in _DELETE_EXPIRED_SQL
        # The min-age floor uses make_interval so a passed integer can't
        # be SQL-injected as a string fragment.
        assert "make_interval(hours => %s)" in _DELETE_EXPIRED_SQL

    def test_returning_ids_for_observability(self):
        assert "RETURNING s.id::text" in _DELETE_EXPIRED_SQL

    def test_uses_cte_to_prelock_victims(self):
        # Without the CTE, ORDER BY + LIMIT inside DELETE is a Postgres
        # extension that doesn't lock predictably under concurrent UPDATE.
        # The CTE is the load-bearing pattern.
        assert "WITH victims AS" in _DELETE_EXPIRED_SQL


# ---------------------------------------------------------------------------
# purge_once — the production code path.
# ---------------------------------------------------------------------------


class TestPurgeOnce:
    @pytest.mark.asyncio
    async def test_returns_ids_from_returning_clause(self):
        fake_conn = _make_async_conn([("id-1",), ("id-2",), ("id-3",)])

        with patch(
            "services.optimizer.session_purger.main.psycopg.AsyncConnection.connect",
            new=AsyncMock(return_value=fake_conn),
        ):
            evicted = await purge_once(Settings())

        assert evicted == ["id-1", "id-2", "id-3"]

    @pytest.mark.asyncio
    async def test_passes_min_age_and_batch_size_as_params(self):
        fake_conn = _make_async_conn([])

        with patch(
            "services.optimizer.session_purger.main.psycopg.AsyncConnection.connect",
            new=AsyncMock(return_value=fake_conn),
        ):
            await purge_once(Settings(min_age_hours=4, batch_size=42))

        # Params land in the order (min_age_hours, batch_size).
        fake_conn._cursor.execute.assert_awaited_once()
        sql_arg, params = fake_conn._cursor.execute.await_args.args
        assert sql_arg is _DELETE_EXPIRED_SQL  # exact same string
        assert params == (4, 42)

    @pytest.mark.asyncio
    async def test_empty_result_returns_empty_list(self):
        """A no-op tick (table is clean) returns [] — not None, not raising."""
        fake_conn = _make_async_conn([])

        with patch(
            "services.optimizer.session_purger.main.psycopg.AsyncConnection.connect",
            new=AsyncMock(return_value=fake_conn),
        ):
            evicted = await purge_once(Settings())

        assert evicted == []

    @pytest.mark.asyncio
    async def test_commits_transaction(self):
        """Without commit() the DELETE rolls back when the connection closes."""
        fake_conn = _make_async_conn([("id-x",)])

        with patch(
            "services.optimizer.session_purger.main.psycopg.AsyncConnection.connect",
            new=AsyncMock(return_value=fake_conn),
        ):
            await purge_once(Settings())

        fake_conn.commit.assert_awaited_once()
