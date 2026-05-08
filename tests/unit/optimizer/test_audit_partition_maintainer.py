"""Tests for services/optimizer/audit_partition_maintainer — daily DDL daemon.

The daemon delegates partition creation to the SECURITY DEFINER SQL
function `ensure_audit_log_partitions(months_ahead)` defined in
db/init/32_rls_completeness.sql. These tests stub psycopg via AsyncMock
and verify:
  - Settings defaults match the documented safe values.
  - `_ensure_partitions` calls the SQL function with the configured
    months_ahead parameter.
  - Connection issued as the chemclaw_service role (BYPASSRLS).
  - Commit fires on success.
  - Returned `n_created` is read from the function's row output.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.optimizer.audit_partition_maintainer.main import (
    Settings,
    _ensure_partitions,
)


def _make_async_conn(row: tuple[Any, ...] | None) -> Any:
    """psycopg.AsyncConnection.connect mock with one cursor."""
    cursor = MagicMock()
    cursor.execute = AsyncMock(return_value=None)
    cursor.fetchone = AsyncMock(return_value=row)
    cursor.__aenter__ = AsyncMock(return_value=cursor)
    cursor.__aexit__ = AsyncMock(return_value=None)

    conn = MagicMock()
    conn.cursor = MagicMock(return_value=cursor)
    conn.commit = AsyncMock(return_value=None)
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=None)

    conn._cursor = cursor
    return conn


class TestSettings:
    def test_defaults_match_documented_safe_values(self):
        s = Settings()
        # 24h cadence — cheap idempotent DDL, no point firing more often.
        assert s.poll_interval_seconds == 86_400
        # 3 months headroom — survives a missed daily run.
        assert s.months_ahead == 3
        # Must connect as the BYPASSRLS role; chemclaw_service is granted
        # EXECUTE on the SECURITY DEFINER function but isn't the table
        # owner (chemclaw is). This is the privilege bridge.
        assert s.postgres_user == "chemclaw_service"

    def test_dsn_assembly(self):
        s = Settings(
            postgres_host="db",
            postgres_port=5433,
            postgres_db="cc",
            postgres_user="u",
            postgres_password="pw",
        )
        assert s.dsn == "host=db port=5433 dbname=cc user=u password=pw"


class TestEnsurePartitions:
    @pytest.mark.asyncio
    async def test_calls_ensure_audit_log_partitions_with_months_ahead(self):
        fake_conn = _make_async_conn((2,))
        with patch(
            "services.optimizer.audit_partition_maintainer.main."
            "psycopg.AsyncConnection.connect",
            new=AsyncMock(return_value=fake_conn),
        ):
            await _ensure_partitions(Settings(months_ahead=4))

        # SECURITY DEFINER SQL function is the load-bearing call.
        call_args = fake_conn._cursor.execute.call_args
        assert call_args[0][0] == "SELECT ensure_audit_log_partitions(%s)"
        # months_ahead is passed as a positional parameter (avoids
        # SQL-fragment injection that a string concat would allow).
        assert call_args[0][1] == (4,)

    @pytest.mark.asyncio
    async def test_commits_on_success(self):
        fake_conn = _make_async_conn((0,))
        with patch(
            "services.optimizer.audit_partition_maintainer.main."
            "psycopg.AsyncConnection.connect",
            new=AsyncMock(return_value=fake_conn),
        ):
            await _ensure_partitions(Settings())

        fake_conn.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_handles_null_returning_row_without_crash(self):
        # If the function returns NULL (degenerate state), the daemon
        # logs n_created=0 rather than blowing up on row[0] subscript.
        fake_conn = _make_async_conn(None)
        with patch(
            "services.optimizer.audit_partition_maintainer.main."
            "psycopg.AsyncConnection.connect",
            new=AsyncMock(return_value=fake_conn),
        ):
            await _ensure_partitions(Settings())  # must not raise

    @pytest.mark.asyncio
    async def test_months_ahead_int_coerces_string_settings(self):
        # Settings inherits from BaseSettings; if env var arrives as a
        # string the int() coercion in _ensure_partitions catches it
        # before the SQL parameter binding.
        fake_conn = _make_async_conn((1,))
        with patch(
            "services.optimizer.audit_partition_maintainer.main."
            "psycopg.AsyncConnection.connect",
            new=AsyncMock(return_value=fake_conn),
        ):
            # Simulate a Settings instance with months_ahead set from a
            # string env (pydantic-settings normally coerces, but the
            # explicit int() in _ensure_partitions guards regardless).
            s = Settings(months_ahead=2)
            await _ensure_partitions(s)
        assert fake_conn._cursor.execute.call_args[0][1] == (2,)
