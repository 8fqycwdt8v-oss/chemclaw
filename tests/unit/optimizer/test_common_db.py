"""Unit tests for services/optimizer/common/db.py.

Mirrors the BYPASSRLS self-check matrix exercised by
`services/projectors/common/base.py::_assert_bypass_rls`. Optimizer workers
that connect via sync `psycopg.connect` use the helpers in this module;
this test pins the contract so the projector and optimizer paths can't
drift.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock

import pytest

from services.optimizer.common.db import (
    assert_bypass_rls,
    enforce_bypass_rls_check_enabled,
    get_dsn,
)


# --------------------------------------------------------------------------
# get_dsn
# --------------------------------------------------------------------------


def test_get_dsn_defaults_to_chemclaw_service(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in (
        "POSTGRES_HOST",
        "POSTGRES_PORT",
        "POSTGRES_DB",
        "POSTGRES_USER",
        "POSTGRES_PASSWORD",
    ):
        monkeypatch.delenv(var, raising=False)

    dsn = get_dsn()

    assert "user=chemclaw_service" in dsn
    assert "host=localhost" in dsn
    assert "port=5432" in dsn
    assert "dbname=chemclaw" in dsn


def test_get_dsn_honours_postgres_user_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("POSTGRES_USER", "chemclaw_app")

    dsn = get_dsn()

    assert "user=chemclaw_app" in dsn


def test_get_dsn_default_user_param(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("POSTGRES_USER", raising=False)

    dsn = get_dsn(default_user="chemclaw_admin")

    assert "user=chemclaw_admin" in dsn


# --------------------------------------------------------------------------
# enforce_bypass_rls_check_enabled
# --------------------------------------------------------------------------


def test_enforce_bypass_rls_check_default_true(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPTIMIZER_ENFORCE_BYPASS_RLS_CHECK", raising=False)

    assert enforce_bypass_rls_check_enabled() is True


@pytest.mark.parametrize("value", ["false", "FALSE", "False"])
def test_enforce_bypass_rls_check_disabled(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("OPTIMIZER_ENFORCE_BYPASS_RLS_CHECK", value)

    assert enforce_bypass_rls_check_enabled() is False


@pytest.mark.parametrize("value", ["true", "TRUE", "1", "yes", ""])
def test_enforce_bypass_rls_check_truthy_values(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("OPTIMIZER_ENFORCE_BYPASS_RLS_CHECK", value)

    assert enforce_bypass_rls_check_enabled() is True


# --------------------------------------------------------------------------
# assert_bypass_rls
# --------------------------------------------------------------------------


def _make_conn(rolbypassrls: bool | None = True, raises: BaseException | None = None) -> MagicMock:
    """Build a sync-psycopg-shaped mock that returns the given rolbypassrls."""
    conn = MagicMock()
    if raises is not None:
        conn.execute.side_effect = raises
        return conn
    cursor = MagicMock()
    cursor.fetchone.return_value = (rolbypassrls,) if rolbypassrls is not None else None
    conn.execute.return_value = cursor
    return conn


def test_assert_bypass_rls_passes_when_role_has_bypass() -> None:
    conn = _make_conn(rolbypassrls=True)

    # Should not raise.
    assert_bypass_rls(conn, service_name="probe")


def test_assert_bypass_rls_raises_when_role_lacks_bypass() -> None:
    conn = _make_conn(rolbypassrls=False)

    with pytest.raises(RuntimeError, match="NOBYPASSRLS role"):
        assert_bypass_rls(conn, service_name="probe")


def test_assert_bypass_rls_disabled_short_circuits() -> None:
    conn = _make_conn(rolbypassrls=False)

    # enforce=False bypasses the check entirely; even a NOBYPASSRLS role passes.
    assert_bypass_rls(conn, service_name="probe", enforce=False)
    conn.execute.assert_not_called()


def test_assert_bypass_rls_swallows_db_error_with_warning(caplog: pytest.LogCaptureFixture) -> None:
    conn = _make_conn(raises=RuntimeError("pg_roles unreadable in test fixture"))

    with caplog.at_level("WARNING"):
        # Doesn't raise even though the probe query exploded.
        assert_bypass_rls(conn, service_name="probe")

    assert any("BYPASSRLS self-check skipped" in r.getMessage() for r in caplog.records)


def test_assert_bypass_rls_warns_on_empty_pg_roles_row(caplog: pytest.LogCaptureFixture) -> None:
    conn = _make_conn(rolbypassrls=None)

    with caplog.at_level("WARNING"):
        assert_bypass_rls(conn, service_name="probe")

    assert any(
        "pg_roles returned no row for current_user" in r.getMessage() for r in caplog.records
    )


def test_assert_bypass_rls_message_names_the_service() -> None:
    conn = _make_conn(rolbypassrls=False)

    with pytest.raises(RuntimeError) as excinfo:
        assert_bypass_rls(conn, service_name="skill_promoter")

    assert "[skill_promoter]" in str(excinfo.value)
    assert "POSTGRES_USER=chemclaw_service" in str(excinfo.value)
