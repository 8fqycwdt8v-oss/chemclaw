"""Shared helpers for optimizer services that connect to Postgres directly.

Optimizer workers (`skill_promoter`, `forged_tool_validator`, `gepa_runner`,
`session_purger`, `session_reanimator`, `audit_partition_maintainer`) all run
as ``chemclaw_service`` (LOGIN BYPASSRLS). This module centralises:

  * DSN composition with the right default user.
  * BYPASSRLS self-check at startup — refuses to run if the connected role
    cannot bypass RLS, because FORCE RLS would silently drop every write.

Mirrors the contract enforced by `services/projectors/common/base.py` for
projectors. Workers that connect via `psycopg.connect` (sync) use this
module; the projector base does the same check for `psycopg.AsyncConnection`.
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import psycopg

logger = logging.getLogger(__name__)


def get_dsn(default_user: str = "chemclaw_service") -> str:
    """Compose the Postgres DSN from environment variables.

    Default user is ``chemclaw_service`` (LOGIN BYPASSRLS) — required because
    `db/init/12_security_hardening.sql` set FORCE ROW LEVEL SECURITY on every
    project-scoped table. Connecting as the owner role (``chemclaw``) without
    setting ``app.current_user_entra_id`` would either silently return zero
    rows or silently drop every INSERT, leaving the daemon dead while
    ``/healthz`` reports green.
    """
    return (
        f"host={os.environ.get('POSTGRES_HOST', 'localhost')} "
        f"port={os.environ.get('POSTGRES_PORT', '5432')} "
        f"dbname={os.environ.get('POSTGRES_DB', 'chemclaw')} "
        f"user={os.environ.get('POSTGRES_USER', default_user)} "
        f"password={os.environ.get('POSTGRES_PASSWORD', '')}"
    )


def assert_bypass_rls(conn: Any, *, service_name: str, enforce: bool = True) -> None:
    """Refuse to start when the connected role lacks BYPASSRLS.

    Catches the env-var-override misconfig where ``POSTGRES_USER`` lands on
    ``chemclaw_app`` (or ``chemclaw`` without superuser-by-entrypoint) instead
    of ``chemclaw_service``. Without this check, FORCE RLS silently drops
    every write and the worker appears to run cleanly while writing nothing.

    Failure modes:
      * ``rolbypassrls`` False AND ``enforce`` True → ``RuntimeError``.
      * ``rolbypassrls`` True → log INFO and return.
      * Any DB error reading ``pg_roles`` (restricted role, mocked psycopg,
        test fixtures) → log WARN and return — must not gate startup on a
        check that the DB itself can't service.

    Mirrors the AsyncConnection variant in
    `services/projectors/common/base.py:_assert_bypass_rls`. Kept sync because
    optimizer services use sync `psycopg.connect`.
    """
    if not enforce:
        return
    try:
        row = conn.execute(
            "SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user"
        ).fetchone()
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[%s] BYPASSRLS self-check skipped: %s "
            "(set OPTIMIZER_ENFORCE_BYPASS_RLS_CHECK=false to silence)",
            service_name,
            exc,
        )
        return
    if row is None:
        logger.warning(
            "[%s] BYPASSRLS self-check: pg_roles returned no row for current_user",
            service_name,
        )
        return
    rolbypassrls = bool(row[0])
    if not rolbypassrls:
        raise RuntimeError(
            f"[{service_name}] connected as a NOBYPASSRLS role; "
            f"FORCE RLS will silently drop writes. Set "
            f"POSTGRES_USER=chemclaw_service or, only when running against a "
            f"non-RLS Postgres, set OPTIMIZER_ENFORCE_BYPASS_RLS_CHECK=false."
        )
    logger.info("[%s] BYPASSRLS self-check passed", service_name)


def enforce_bypass_rls_check_enabled() -> bool:
    """Read the OPTIMIZER_ENFORCE_BYPASS_RLS_CHECK env-var (default true)."""
    return os.environ.get("OPTIMIZER_ENFORCE_BYPASS_RLS_CHECK", "true").lower() != "false"


def connect_with_assert(default_user: str = "chemclaw_service", *, service_name: str) -> Any:
    """Open a sync connection, assert BYPASSRLS, return the connection.

    The caller is responsible for closing the connection (use as context
    manager: ``with connect_with_assert(...) as conn:``).
    """
    import psycopg  # imported lazily so optimizer-shared callers without psycopg installed don't fail at import time

    conn = psycopg.connect(get_dsn(default_user))
    try:
        assert_bypass_rls(conn, service_name=service_name, enforce=enforce_bypass_rls_check_enabled())
    except Exception:
        conn.close()
        raise
    return conn
