"""Schema sanity for derivation_class columns + hypotheses.confirmed_by (Phase 0)."""
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

TARGET_TABLES = ["reactions", "hypotheses", "artifacts", "compute_results"]


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


def test_derivation_class_column_present_on_all_targets(conn):
    for table in TARGET_TABLES:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT column_name, data_type, is_nullable "
                "FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name=%s "
                "  AND column_name='derivation_class'",
                (table,),
            )
            row = cur.fetchone()
        assert row is not None, f"{table}.derivation_class missing"
        col, dtype, nullable = row
        assert dtype == "text", f"{table}.derivation_class is {dtype}, want text"
        assert nullable == "YES", f"{table}.derivation_class should be nullable"


def test_derivation_class_check_constraint_present(conn):
    """Each target table has a CHECK constraint listing the 5 valid values
    (or NULL). The CHECK is created NOT VALID so historical rows don't trip
    the migration, but new INSERTs with a bogus value must fail."""
    for table in TARGET_TABLES:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT conname FROM pg_constraint "
                "WHERE conrelid = %s::regclass "
                "  AND contype = 'c' "
                "  AND conname LIKE '%%derivation_class%%'",
                (table,),
            )
            rows = [r[0] for r in cur.fetchall()]
        assert rows, f"{table} missing derivation_class CHECK"


def test_hypotheses_confirmed_by_present(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name='hypotheses' "
            "  AND column_name='confirmed_by'"
        )
        row = cur.fetchone()
    assert row is not None, "hypotheses.confirmed_by missing"


def test_hypotheses_confirmed_by_fk_to_facts(conn):
    """confirmed_by FK should target facts(id)."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT c.confrelid::regclass::text "
            "FROM pg_constraint c "
            "WHERE c.conrelid='hypotheses'::regclass "
            "  AND c.contype='f' "
            "  AND c.conkey = ARRAY["
            "    (SELECT attnum FROM pg_attribute "
            "     WHERE attrelid='hypotheses'::regclass "
            "       AND attname='confirmed_by')"
            "  ]::smallint[]"
        )
        row = cur.fetchone()
    assert row is not None and row[0] == "facts", f"expected FK→facts; got {row}"
