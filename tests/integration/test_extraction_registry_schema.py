"""Schema sanity for db/init/63_extraction_registry.sql (Phase 0)."""
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


def test_extraction_registry_exists(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.extraction_registry')")
        assert cur.fetchone()[0] == "extraction_registry"


def test_extraction_registry_pk_is_composite(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT a.attname FROM pg_index i "
            "JOIN pg_attribute a ON a.attrelid = i.indrelid "
            "  AND a.attnum = ANY(i.indkey) "
            "WHERE i.indrelid = 'extraction_registry'::regclass "
            "  AND i.indisprimary ORDER BY a.attnum"
        )
        cols = [r[0] for r in cur.fetchall()]
    assert cols == ["source_kind", "source_name", "result_schema_id"]


def test_extraction_registry_source_kind_check(conn):
    with conn.cursor() as cur, pytest.raises(psycopg.errors.CheckViolation):
        cur.execute(
            "INSERT INTO extraction_registry "
            "(source_kind, source_name, result_schema_id, extractor_module) "
            "VALUES ('bogus', 't', 'v1', 'm')"
        )
    conn.rollback()


def test_extraction_registry_defaults(conn):
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO extraction_registry "
            "(source_kind, source_name, result_schema_id, extractor_module) "
            "VALUES ('mcp_tool', 'test.dummy', 'v1', 'noop.module') "
            "RETURNING enabled, promote_default"
        )
        enabled, promote = cur.fetchone()
    assert enabled is True
    assert promote is True
    conn.rollback()
