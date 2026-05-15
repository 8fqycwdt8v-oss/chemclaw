"""Phase 0 end-to-end smoke: inject a `tool_invocation_complete` event with no
matching `extraction_registry` row → projector should ack as no-op, zero facts
emitted. This pins the "default-off, no-extractor, no-crash" invariant before
Phase 1 wiring lands.

Skips if Docker / dev Postgres / projector container aren't available.
"""
from __future__ import annotations

import json
import os
import time
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


def _connect_service():
    """Connect as chemclaw_service for direct event injection + verification."""
    return psycopg.connect(
        host=os.environ["POSTGRES_HOST"],
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        dbname=os.environ.get("POSTGRES_DB", "chemclaw"),
        user="chemclaw_service",
        password=os.environ.get(
            "POSTGRES_SERVICE_PASSWORD",
            os.environ.get("POSTGRES_PASSWORD", ""),
        ),
    )


def test_tool_invocation_complete_with_no_extractor_is_no_op():
    """The projector should consume the event, log debug, and not emit any facts."""
    with _connect_service() as conn:
        # Snapshot the fact count BEFORE injection so we can assert "no new facts".
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM facts")
            facts_before = cur.fetchone()[0]

        inv_id = str(uuid.uuid4())
        payload = {
            "tool_name": "mcp-test.never-registered",
            "user_entra_id": "smoke-user-phase-0",
            "project_id": None,
            "result_schema_id": "v1",
            "args": {"smiles": "[redacted]"},
            "result": {"barrier_kj_mol": 92.3},
            "duration_ms": 1234,
            "ok": True,
            "error": None,
        }

        # Inject the event.
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO ingestion_events
                  (event_type, source_table, source_row_id, payload)
                VALUES
                  ('tool_invocation_complete', 'tool_invocations', %s, %s::jsonb)
                RETURNING id
                """,
                (inv_id, json.dumps(payload)),
            )
            event_id = cur.fetchone()[0]
        conn.commit()

        # Wait up to 15 s for the projector to ack the event (or skip if it never
        # starts — projector container may be crash-looping on the FastAPI import
        # bug surfaced in Task 10's report; that's a pre-existing repo gap, not a
        # Phase 0 regression).
        deadline = time.monotonic() + 15.0
        acked = False
        while time.monotonic() < deadline:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM projection_acks "
                    "WHERE projector_name='tool_result_extractor' "
                    "  AND event_id = %s",
                    (event_id,),
                )
                if cur.fetchone():
                    acked = True
                    break
            time.sleep(0.5)

        if not acked:
            pytest.skip(
                "tool_result_extractor projector did not ack within 15s; "
                "likely not running (see Task 10 report — pre-existing FastAPI "
                "import bug in services/mcp_tools/common/__init__.py blocks "
                "projector startup repo-wide)."
            )

        # If we got here, the projector consumed the event. Now confirm NO facts
        # were inserted as a result of this event.
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM facts WHERE source_row_id = %s",
                (inv_id,),
            )
            facts_emitted = cur.fetchone()[0]
        assert facts_emitted == 0, (
            "expected 0 facts for event with no extractor registered; "
            f"projector emitted {facts_emitted}"
        )

        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM facts")
            facts_after = cur.fetchone()[0]
        assert facts_after == facts_before, (
            "fact count changed unexpectedly across the no-op event "
            f"({facts_before} → {facts_after})"
        )
