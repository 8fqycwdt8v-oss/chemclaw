"""Schema sanity for the investigation_queue + investigation_budget_usage tables (Phase 0)."""
from __future__ import annotations

import os
import psycopg
import pytest

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.getenv("POSTGRES_HOST"),
        reason="POSTGRES_HOST not set; skipping integration test",
    ),
]


@pytest.fixture
def conn():
    with psycopg.connect(
        host=os.environ["POSTGRES_HOST"],
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        dbname=os.environ.get("POSTGRES_DB", "chemclaw"),
        user=os.environ.get("POSTGRES_USER", "chemclaw"),
        password=os.environ.get("POSTGRES_PASSWORD", ""),
    ) as c:
        yield c


def test_investigation_queue_exists(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.investigation_queue')")
        assert cur.fetchone()[0] == "investigation_queue"


def test_investigation_queue_pending_index(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT indexname FROM pg_indexes "
            "WHERE tablename='investigation_queue'"
        )
        names = {r[0] for r in cur.fetchall()}
    assert "idx_investigation_queue_pending" in names


def test_investigation_queue_fact_fk(conn):
    """FK from investigation_queue.fact_id to facts.id."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT conname FROM pg_constraint "
            "WHERE conrelid='investigation_queue'::regclass "
            "  AND contype='f'"
        )
        fks = [r[0] for r in cur.fetchall()]
    assert any("fact" in fk.lower() for fk in fks), f"expected FK to facts; got {fks}"


def test_investigation_budget_usage_exists(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.investigation_budget_usage')")
        assert cur.fetchone()[0] == "investigation_budget_usage"


def test_investigation_budget_usage_pk(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT a.attname FROM pg_index i "
            "JOIN pg_attribute a ON a.attrelid = i.indrelid "
            "  AND a.attnum = ANY(i.indkey) "
            "WHERE i.indrelid = 'investigation_budget_usage'::regclass "
            "  AND i.indisprimary ORDER BY a.attnum"
        )
        cols = [r[0] for r in cur.fetchall()]
    assert cols == ["scope", "scope_id", "date_utc"]


def test_investigation_budget_scope_check(conn):
    with conn.cursor() as cur, pytest.raises(psycopg.errors.CheckViolation):
        cur.execute(
            "INSERT INTO investigation_budget_usage "
            "(scope, scope_id, date_utc) "
            "VALUES ('bogus', 'x', CURRENT_DATE)"
        )
    conn.rollback()
