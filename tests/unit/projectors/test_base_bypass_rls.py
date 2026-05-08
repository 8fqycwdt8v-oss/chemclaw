"""Tests for BaseProjector._assert_bypass_rls — the startup self-check
that refuses to start unless the connected role has BYPASSRLS.

Without it, a POSTGRES_USER misconfig (e.g. landing on chemclaw_app
which is NOBYPASSRLS) silently dropped every projector INSERT under
FORCE RLS — empty KG with no error trail.
"""

from __future__ import annotations

from typing import Any

import pytest  # noqa: F401  — kept for asyncio plugin auto-detection

from services.projectors.common.base import BaseProjector


class _CursorReturning:
    """Minimal async-cursor stub returning a fixed dict-row on fetchone()."""

    def __init__(self, row: dict[str, Any] | None) -> None:
        self._row = row
        self.queries: list[str] = []

    async def __aenter__(self) -> "_CursorReturning":
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def execute(self, sql: str, *_args: object) -> None:
        self.queries.append(sql)

    async def fetchone(self) -> dict[str, Any] | None:
        return self._row


class _FakeConn:
    def __init__(self, row: dict[str, Any] | None) -> None:
        self._row = row

    def cursor(self) -> _CursorReturning:
        return _CursorReturning(self._row)


class _StubProjector(BaseProjector):
    """Concrete BaseProjector subclass for the assertion test only."""

    name = "stub"
    interested_event_types = ()

    async def handle(self, *_args: object, **_kwargs: object) -> None:  # noqa: D401
        return None


def _make_projector() -> _StubProjector:
    # BaseProjector takes a settings object; the assert path doesn't
    # consult settings, so an empty object via __new__ is sufficient.
    p = _StubProjector.__new__(_StubProjector)
    return p


async def test_assert_bypass_rls_passes_when_role_has_bypass() -> None:
    p = _make_projector()
    conn = _FakeConn({"role": "chemclaw_service", "bypass": True})
    # Should not raise.
    await p._assert_bypass_rls(conn)  # type: ignore[arg-type]


async def test_assert_bypass_rls_refuses_when_role_lacks_bypass() -> None:
    p = _make_projector()
    conn = _FakeConn({"role": "chemclaw_app", "bypass": False})
    with pytest.raises(RuntimeError, match=r"chemclaw_app"):
        await p._assert_bypass_rls(conn)  # type: ignore[arg-type]


async def test_assert_bypass_rls_refuses_when_no_role_row_returned() -> None:
    # Defense-in-depth: if pg_roles returns no row for current_user
    # (effectively impossible but defensively-handled), refuse boot.
    p = _make_projector()
    conn = _FakeConn(None)
    with pytest.raises(RuntimeError, match=r"BYPASSRLS"):
        await p._assert_bypass_rls(conn)  # type: ignore[arg-type]
