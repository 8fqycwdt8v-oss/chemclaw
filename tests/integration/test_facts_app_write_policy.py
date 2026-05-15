"""End-to-end verification that the agent (chemclaw_app role) CAN insert
agent-promoted facts and investigation_queue rows, and CANNOT bypass the
class / score restrictions via direct SQL.

Skipped unless ``POSTGRES_HOST`` is set in the environment. Use:

    POSTGRES_HOST=localhost POSTGRES_PORT=5433 \\
      POSTGRES_APP_PASSWORD=<pw> \\
      .venv/bin/pytest tests/integration/test_facts_app_write_policy.py -v -m integration

Requires ``docker compose up -d postgres && make db.init`` to be running
first, and the chemclaw_app role to have a known password. Mirrors the
gating convention used by ``tests/integration/test_facts_table_schema.py``.
"""
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
    """Connect as chemclaw_app (NOT chemclaw / chemclaw_service)."""
    password = os.environ.get(
        "POSTGRES_APP_PASSWORD",
        os.environ.get("POSTGRES_PASSWORD", ""),
    )
    with psycopg.connect(
        host=os.environ["POSTGRES_HOST"],
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        dbname=os.environ.get("POSTGRES_DB", "chemclaw"),
        user="chemclaw_app",
        password=password,
    ) as c:
        # Set the current user context required by RLS.
        with c.cursor() as cur:
            cur.execute(
                "SELECT set_config('app.current_user_entra_id', %s, false)",
                ("test-user-phase-0",),
            )
        yield c


def test_app_role_can_insert_agent_promoted_fact(conn):
    """chemclaw_app may INSERT facts when extractor + class + source match."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO facts (
              subject_label, subject_id_value, predicate,
              object_value, derivation_class, confidence, confidence_tier,
              source_table, source_row_id, extractor_name
            ) VALUES (
              'Compound', 'TEST_INCHI_001', 'agent_concluded_property',
              '{"v": true}'::jsonb, 'INTERPRETED', 0.85, 'high',
              'agent_promotion', 'test-user-phase-0', 'promote_to_kg'
            ) RETURNING id
            """
        )
        row = cur.fetchone()
        assert row is not None
        assert row[0] is not None
    conn.rollback()


def test_app_role_cannot_insert_observed_fact(conn):
    """OBSERVED is reserved for measurement-emitting projectors."""
    with conn.cursor() as cur, pytest.raises(psycopg.errors.InsufficientPrivilege):
        cur.execute(
            """
            INSERT INTO facts (
              subject_label, subject_id_value, predicate,
              object_value, derivation_class, confidence, confidence_tier,
              source_table, source_row_id, extractor_name
            ) VALUES (
              'Compound', 'TEST_INCHI_002', 'has_property',
              '{"v": true}'::jsonb, 'OBSERVED', 0.95, 'high',
              'agent_promotion', 'test-user-phase-0', 'promote_to_kg'
            )
            """
        )
    conn.rollback()


def test_app_role_cannot_forge_extractor_name(conn):
    """The WITH CHECK pins extractor_name to the allowed two-value set."""
    with conn.cursor() as cur, pytest.raises(psycopg.errors.InsufficientPrivilege):
        cur.execute(
            """
            INSERT INTO facts (
              subject_label, subject_id_value, predicate,
              object_value, derivation_class, confidence, confidence_tier,
              source_table, source_row_id, extractor_name
            ) VALUES (
              'Compound', 'TEST_INCHI_003', 'p',
              '{}'::jsonb, 'INTERPRETED', 0.5, 'medium',
              'agent_promotion', 'x', 'kg_source_cache'
            )
            """
        )
    conn.rollback()


def test_app_role_can_enqueue_manual_investigation(conn):
    """chemclaw_app may enqueue when score=1.0 AND manual_request in reason_codes."""
    with conn.cursor() as cur:
        # First insert a fact so the FK target exists.
        cur.execute(
            """
            INSERT INTO facts (
              subject_label, subject_id_value, predicate, object_value,
              derivation_class, confidence, confidence_tier,
              source_table, source_row_id, extractor_name
            ) VALUES (
              'Compound', 'TEST_FQ', 'p', '{}'::jsonb,
              'INTERPRETED', 0.5, 'medium',
              'agent_promotion', 'x', 'promote_to_kg'
            ) RETURNING id
            """
        )
        fact_id = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO investigation_queue (fact_id, score, reason_codes)
            VALUES (%s, 1.0, %s)
            RETURNING id
            """,
            (fact_id, ["manual_request", "test deep dive"]),
        )
        queue_id = cur.fetchone()[0]
        assert queue_id is not None
    conn.rollback()


def test_app_role_cannot_enqueue_non_manual(conn):
    """Low-score / no-manual_request enqueues must come from chemclaw_service."""
    with conn.cursor() as cur, pytest.raises(psycopg.errors.InsufficientPrivilege):
        cur.execute(
            """
            INSERT INTO facts (
              subject_label, subject_id_value, predicate, object_value,
              derivation_class, confidence, confidence_tier,
              source_table, source_row_id, extractor_name
            ) VALUES (
              'Compound', 'TEST_FQ2', 'p', '{}'::jsonb,
              'INTERPRETED', 0.5, 'medium',
              'agent_promotion', 'x', 'promote_to_kg'
            ) RETURNING id
            """
        )
        fact_id = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO investigation_queue (fact_id, score, reason_codes)
            VALUES (%s, 0.5, %s)
            """,
            (fact_id, ["periodic_sweep"]),
        )
    conn.rollback()
