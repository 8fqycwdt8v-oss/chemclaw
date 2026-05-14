"""Schema + RLS unit tests for the canonical ``facts`` table (Phase 0).

Skipped unless ``POSTGRES_HOST`` is set in the environment. Use:

    POSTGRES_HOST=localhost POSTGRES_PASSWORD=<pw> \\
        .venv/bin/pytest tests/unit/db/test_facts_table_schema.py -v

Requires ``docker compose up -d postgres && make db.init`` to be running
first. Mirrors the gating convention used by
``tests/integration/test_hypotheses_schema.py``.

Exercises:
  - ``public.facts`` exists (``to_regclass``)
  - all required columns from the Phase-0 spec are present
  - ``derivation_class`` CHECK rejects unknown values
  - ``polarity`` CHECK rejects unknown values
  - ``relrowsecurity`` AND ``relforcerowsecurity`` are both true
"""
from __future__ import annotations

import os

import psycopg
import pytest


pytestmark = pytest.mark.skipif(
    not os.getenv("POSTGRES_HOST"),
    reason="set POSTGRES_HOST (and POSTGRES_PASSWORD) to run Postgres schema tests",
)


def _dsn() -> str:
    host = os.getenv("POSTGRES_HOST", "localhost")
    port = os.getenv("POSTGRES_PORT", "5432")
    db = os.getenv("POSTGRES_DB", "chemclaw")
    user = os.getenv("POSTGRES_USER", "chemclaw")
    password = os.getenv("POSTGRES_PASSWORD", "")
    return f"host={host} port={port} dbname={db} user={user} password={password}"


def _bypass_rls(cur: psycopg.Cursor) -> None:  # type: ignore[type-arg]
    """Switch to the BYPASSRLS service role for inserts inside tests.

    Mirrors the helper in ``tests/integration/test_hypotheses_schema.py``.
    Falls through silently on envs where the role doesn't exist (e.g. an
    owner-only DB) since the DB owner bypasses RLS implicitly.
    """
    try:
        cur.execute("SET LOCAL ROLE chemclaw_service")
    except psycopg.errors.InvalidParameterValue:
        pass


@pytest.fixture
def conn():
    with psycopg.connect(_dsn()) as c:
        yield c


def test_facts_table_exists(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.facts')")
        assert cur.fetchone()[0] == "facts"


def test_facts_required_columns(conn):
    expected = {
        "id", "project_id", "subject_label", "subject_id_value",
        "predicate", "object_label", "object_id_value", "object_value",
        "unit", "polarity", "derivation_class", "confidence",
        "confidence_tier", "source_table", "source_row_id",
        "source_fact_ids", "extractor_name", "derivation_depth",
        "valid_from", "valid_to", "invalidated_by",
        "invalidation_reason", "created_at", "group_id",
    }
    with conn.cursor() as cur:
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name='facts'"
        )
        actual = {r[0] for r in cur.fetchall()}
    missing = expected - actual
    assert not missing, f"missing columns: {missing}"


def test_facts_derivation_class_check(conn):
    # Writes go through chemclaw_service (BYPASSRLS); the table's SELECT
    # policy only gates reads. We expect a CheckViolation (not RLS denial)
    # for an invalid derivation_class.
    try:
        with conn.cursor() as cur:
            _bypass_rls(cur)
            with pytest.raises(psycopg.errors.CheckViolation):
                cur.execute(
                    "INSERT INTO facts (subject_label, subject_id_value, predicate, "
                    "derivation_class, confidence, confidence_tier, extractor_name) "
                    "VALUES ('Compound', 'A', 'p', 'GARBAGE', 0.5, 'low', 'test')"
                )
    finally:
        conn.rollback()


def test_facts_polarity_check(conn):
    try:
        with conn.cursor() as cur:
            _bypass_rls(cur)
            with pytest.raises(psycopg.errors.CheckViolation):
                cur.execute(
                    "INSERT INTO facts (subject_label, subject_id_value, predicate, "
                    "polarity, derivation_class, confidence, confidence_tier, "
                    "extractor_name) VALUES ('Compound', 'A', 'p', 'maybe', "
                    "'OBSERVED', 0.5, 'low', 'test')"
                )
    finally:
        conn.rollback()


def test_facts_rls_enabled(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
            "WHERE relname='facts'"
        )
        rls_enabled, rls_forced = cur.fetchone()
        assert rls_enabled is True
        assert rls_forced is True
