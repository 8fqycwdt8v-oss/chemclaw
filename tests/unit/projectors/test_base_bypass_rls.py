"""Tests for BaseProjector._assert_bypass_rls.

Covers the deferred-D3 startup self-check that refuses to start when
the connected role lacks BYPASSRLS — the env-var-override misconfig
where POSTGRES_USER accidentally lands on chemclaw_app instead of
chemclaw_service. FORCE RLS would then silently drop every projector
INSERT and the KG / vector-store would simply be empty with no error
trail.

Failure modes asserted:
  - rolbypassrls=False AND check enabled → RuntimeError
  - rolbypassrls=True → no exception
  - check disabled via setting → no DB query at all
  - DB error during the check → log WARN and proceed
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from services.projectors.common.base import BaseProjector, ProjectorSettings


class _MinimalProjector(BaseProjector):
    """Tiniest concrete subclass to instantiate BaseProjector."""

    name = "test-projector"
    interested_event_types = ()

    async def handle(  # type: ignore[override]
        self,
        cur: Any,
        event_id: int,
        event_type: str,
        source_table: str | None,
        source_row_id: str | None,
        payload: dict[str, Any],
    ) -> None:
        return None


def _make_work_conn(fetchone_result: dict[str, Any] | None = None,
                    raise_on_execute: Exception | None = None) -> Any:
    """Construct a mock psycopg.AsyncConnection that supports
    `async with conn.cursor() as cur` + `cur.execute()` + `cur.fetchone()`."""
    cursor = MagicMock()
    if raise_on_execute is not None:
        cursor.execute = AsyncMock(side_effect=raise_on_execute)
    else:
        cursor.execute = AsyncMock(return_value=None)
    cursor.fetchone = AsyncMock(return_value=fetchone_result)
    cursor.__aenter__ = AsyncMock(return_value=cursor)
    cursor.__aexit__ = AsyncMock(return_value=None)

    conn = MagicMock()
    conn.cursor = MagicMock(return_value=cursor)
    conn._cursor = cursor
    return conn


@pytest.mark.asyncio
async def test_passes_when_role_has_bypassrls():
    settings = ProjectorSettings()
    p = _MinimalProjector(settings)
    work_conn = _make_work_conn({"rolbypassrls": True})

    # Must not raise.
    await p._assert_bypass_rls(work_conn)
    work_conn._cursor.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_raises_when_role_lacks_bypassrls():
    settings = ProjectorSettings()
    p = _MinimalProjector(settings)
    work_conn = _make_work_conn({"rolbypassrls": False})

    with pytest.raises(RuntimeError, match="NOBYPASSRLS"):
        await p._assert_bypass_rls(work_conn)


@pytest.mark.asyncio
async def test_skipped_when_check_disabled():
    """The escape hatch — no DB query when the setting is false."""
    settings = ProjectorSettings(enforce_bypass_rls_check=False)
    p = _MinimalProjector(settings)
    work_conn = _make_work_conn()

    await p._assert_bypass_rls(work_conn)
    # Cursor never opened — early-return is the contract.
    work_conn.cursor.assert_not_called()


@pytest.mark.asyncio
async def test_warns_and_continues_when_pg_roles_unreadable():
    """Restricted-role / mocked-Postgres fallback: a cursor failure
    must not block startup. Documented in _assert_bypass_rls docstring."""
    from psycopg import OperationalError

    settings = ProjectorSettings()
    p = _MinimalProjector(settings)
    work_conn = _make_work_conn(raise_on_execute=OperationalError("permission denied"))

    # Must not raise — the WARN log is the contract.
    await p._assert_bypass_rls(work_conn)


@pytest.mark.asyncio
async def test_warns_and_continues_when_pg_roles_returns_no_row():
    """Edge case — current_user not present in pg_roles (e.g. logical
    replication subscriber). Don't fail; log and proceed."""
    settings = ProjectorSettings()
    p = _MinimalProjector(settings)
    work_conn = _make_work_conn(fetchone_result=None)

    await p._assert_bypass_rls(work_conn)
