"""Phase 0 happy-path smoke: simulate the agent calling promote_to_kg then
request_investigation. Verifies that under chemclaw_app (the agent's actual
runtime role) both writes succeed against the FORCE-RLS-protected tables
and that the matching `extracted_fact` ingestion event is emitted (which
Phase 1's investigation_scorer would consume).

This is a pure SQL flow (no harness invocation) — the goal is to pin the
DB-layer contracts that promote_to_kg / request_investigation rely on.
"""
from __future__ import annotations

import os
import uuid

import psycopg
import pytest

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.getenv("POSTGRES_HOST"),
        reason="POSTGRES_HOST not set; skipping integration test",
    ),
]


def _connect_app():
    conn = psycopg.connect(
        host=os.environ["POSTGRES_HOST"],
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        dbname=os.environ.get("POSTGRES_DB", "chemclaw"),
        user="chemclaw_app",
        password=os.environ.get(
            "POSTGRES_APP_PASSWORD",
            os.environ.get("POSTGRES_PASSWORD", ""),
        ),
    )
    with conn.cursor() as cur:
        cur.execute(
            "SELECT set_config('app.current_user_entra_id', %s, false)",
            ("phase-0-smoke-user",),
        )
    return conn


def test_promote_then_request_investigation_flow():
    with _connect_app() as conn:
        # Step 1 — promote_to_kg-shaped INSERT (the builtin does this via withUserContext).
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO facts (
                  subject_label, subject_id_value, predicate, object_value,
                  derivation_class, confidence, confidence_tier,
                  source_table, source_row_id, extractor_name, source_fact_ids
                ) VALUES (
                  'Compound', %s, 'agent_concluded_property',
                  '{"property": "soluble_DMSO", "verdict": true}'::jsonb,
                  'INTERPRETED', 0.85, 'high',
                  'agent_promotion', 'phase-0-smoke-user', 'promote_to_kg',
                  ARRAY[]::uuid[]
                ) RETURNING id
                """,
                (f"SMOKE_INCHI_{uuid.uuid4()}",),
            )
            fact_id = cur.fetchone()[0]
            assert fact_id is not None

            # Step 2 — emit the extracted_fact event (the builtin does this too).
            # ingestion_events.source_row_id is UUID — pass fact_id directly.
            cur.execute(
                """
                INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
                VALUES (
                  'extracted_fact', 'facts', %s,
                  jsonb_build_object(
                    'fact_id', %s::text,
                    'extractor', 'promote_to_kg',
                    'derivation_class', 'INTERPRETED',
                    'predicate', 'agent_concluded_property'
                  )
                ) RETURNING id
                """,
                (fact_id, str(fact_id)),
            )
            event_id = cur.fetchone()[0]
            assert event_id is not None

            # Step 3 — request_investigation-shaped INSERT pointing at the fact.
            cur.execute(
                """
                INSERT INTO investigation_queue (fact_id, score, reason_codes)
                VALUES (%s, 1.0, %s)
                RETURNING id
                """,
                (fact_id, ["manual_request", "smoke deep-dive please"]),
            )
            queue_id = cur.fetchone()[0]
            assert queue_id is not None

            # Verify both rows are visible to this user.
            cur.execute(
                "SELECT confidence_tier, derivation_class FROM facts WHERE id = %s",
                (fact_id,),
            )
            tier, dclass = cur.fetchone()
            assert tier == "high"
            assert dclass == "INTERPRETED"

            cur.execute(
                "SELECT score, picked_at FROM investigation_queue WHERE id = %s",
                (queue_id,),
            )
            score, picked_at = cur.fetchone()
            assert float(score) == 1.0
            assert picked_at is None, (
                "queue row should be pending (no interpreter in Phase 0)"
            )

        conn.rollback()  # smoke test — don't leave rows in dev DB


def test_chemclaw_app_cannot_insert_observed_facts():
    """Defense in depth: even with the right context set, chemclaw_app cannot
    forge an OBSERVED fact (those are reserved for projectors)."""
    with _connect_app() as conn:
        with conn.cursor() as cur, pytest.raises(psycopg.errors.InsufficientPrivilege):
            cur.execute(
                """
                INSERT INTO facts (
                  subject_label, subject_id_value, predicate, object_value,
                  derivation_class, confidence, confidence_tier,
                  source_table, source_row_id, extractor_name
                ) VALUES (
                  'Compound', %s, 'has_property', '{}'::jsonb,
                  'OBSERVED', 0.99, 'high',
                  'agent_promotion', 'phase-0-smoke-user', 'promote_to_kg'
                )
                """,
                (f"SMOKE_OBS_{uuid.uuid4()}",),
            )
        conn.rollback()
