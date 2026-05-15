"""Verify the 8 new investigation/extraction event_type rows exist in
ingestion_event_catalog (Phase 0)."""
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

REQUIRED_EVENTS = [
    "tool_invocation_complete",
    "extracted_fact",
    "anomaly_observed",
    "pattern_detected",
    "interpretation_proposed",
    "investigation_requested",
    "test_planned",
    "external_data_fetched",
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


def test_all_new_events_cataloged(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT event_type FROM ingestion_event_catalog")
        cataloged = {r[0] for r in cur.fetchall()}
    missing = set(REQUIRED_EVENTS) - cataloged
    assert not missing, f"missing event_types: {missing}"


def test_new_events_have_descriptions(conn):
    """Every new row carries a non-empty description and emitted_by."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT event_type, description, emitted_by FROM ingestion_event_catalog "
            "WHERE event_type = ANY(%s)",
            (REQUIRED_EVENTS,),
        )
        rows = cur.fetchall()
    assert len(rows) == len(REQUIRED_EVENTS)
    for event_type, description, emitted_by in rows:
        assert description and len(description) > 10, \
            f"{event_type}: description missing or too short"
        assert emitted_by and len(emitted_by) > 0, \
            f"{event_type}: emitted_by missing"


def test_extracted_fact_consumed_by_includes_scorer(conn):
    """Spec §4.1.3: extracted_fact should be consumed by investigation_scorer + kg_facts_sync."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT consumed_by FROM ingestion_event_catalog "
            "WHERE event_type='extracted_fact'"
        )
        row = cur.fetchone()
    assert row is not None
    consumed_by = row[0]
    assert "investigation_scorer" in consumed_by
    assert "kg_facts_sync" in consumed_by
