"""Tests for ProjectorSettings defaults — RLS-role contract.

Per CLAUDE.md "Row-Level Security": projectors connect as `chemclaw_service`
(BYPASSRLS explicit). The table-owner role `chemclaw` is reserved for
db/init / migrations and must never be used for app traffic. This file pins
the default so a future refactor can't silently revert to the table owner
(which previously caused kg_hypotheses + kg_documents to issue defensive
`SET LOCAL ROLE chemclaw_service` mid-connection workarounds).
"""

from __future__ import annotations

import pytest

from services.projectors.common.base import ProjectorSettings


def test_default_postgres_user_is_chemclaw_service(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default `postgres_user` MUST be `chemclaw_service` — not the table-owner."""
    # Strip any inherited POSTGRES_USER from the test runner so we observe
    # the real default rather than an env override.
    monkeypatch.delenv("POSTGRES_USER", raising=False)
    monkeypatch.delenv("PGUSER", raising=False)
    settings = ProjectorSettings(_env_file=None)  # type: ignore[call-arg]
    assert settings.postgres_user == "chemclaw_service", (
        "ProjectorSettings.postgres_user must default to chemclaw_service per "
        "CLAUDE.md RLS contract; the table-owner `chemclaw` is reserved for "
        "db/init only."
    )


def test_postgres_user_is_overridable_via_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Operators can still override via POSTGRES_USER env var."""
    monkeypatch.setenv("POSTGRES_USER", "custom_role")
    settings = ProjectorSettings(_env_file=None)  # type: ignore[call-arg]
    assert settings.postgres_user == "custom_role"


def test_dsn_uses_resolved_user(monkeypatch: pytest.MonkeyPatch) -> None:
    """DSN string carries the resolved user (default or override)."""
    monkeypatch.delenv("POSTGRES_USER", raising=False)
    monkeypatch.delenv("PGUSER", raising=False)
    settings = ProjectorSettings(_env_file=None)  # type: ignore[call-arg]
    assert "user=chemclaw_service" in settings.postgres_dsn
    # Password is empty by default — should still be present in the DSN
    # (psycopg parses `password=` as empty), not omitted.
    assert "password=" in settings.postgres_dsn
