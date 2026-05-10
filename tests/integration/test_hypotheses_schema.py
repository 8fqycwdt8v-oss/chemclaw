"""Schema + RLS integration tests for the hypotheses table pair.

Skipped unless POSTGRES_HOST is set in the environment. Use:

    POSTGRES_HOST=localhost POSTGRES_PASSWORD=<pw> \\
        pytest tests/integration/test_hypotheses_schema.py -v -m integration

Requires `docker compose up -d postgres && make db.init` to be running first.

Exercises:
  - confidence_tier generated column (high / medium / low tiers)
  - hypothesis_text length CHECK constraint
  - confidence bounds CHECK constraint
  - RLS owner-sees-own, cross-portfolio (scope_nce_project_id IS NULL)
  - CASCADE delete of hypothesis_citations when parent hypothesis is deleted
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
        reason="set POSTGRES_HOST (and POSTGRES_PASSWORD) to run Postgres integration tests",
    ),
]


def _dsn() -> str:
    host = os.getenv("POSTGRES_HOST", "localhost")
    port = os.getenv("POSTGRES_PORT", "5432")
    db = os.getenv("POSTGRES_DB", "chemclaw")
    user = os.getenv("POSTGRES_USER", "chemclaw")
    password = os.getenv("POSTGRES_PASSWORD", "")
    return f"host={host} port={port} dbname={db} user={user} password={password}"


def _connect() -> psycopg.Connection:  # type: ignore[type-arg]
    return psycopg.connect(_dsn())


def _bypass_rls(cur: psycopg.Cursor) -> None:  # type: ignore[type-arg]
    """Switch to the BYPASSRLS service role for admin inserts inside tests."""
    try:
        cur.execute("SET LOCAL ROLE chemclaw_service")
    except psycopg.errors.InvalidParameterValue:
        # chemclaw_service role doesn't exist on this env (e.g. fresh DB owner
        # connection) — the DB owner bypasses RLS implicitly, so this is fine.
        pass


def _set_user(cur: psycopg.Cursor, entra_id: str) -> None:  # type: ignore[type-arg]
    cur.execute("SELECT set_config('app.current_user_entra_id', %s, true)", (entra_id,))


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_confidence_tier_generated_column() -> None:
    """Generated column maps 0.91→high, 0.65→medium, 0.2→low."""
    conn = _connect()
    try:
        with conn.transaction():
            with conn.cursor() as cur:
                _bypass_rls(cur)

                cur.execute(
                    "INSERT INTO hypotheses "
                    "(hypothesis_text, confidence, proposed_by_user_entra_id) "
                    "VALUES (%s, %s, %s) RETURNING confidence_tier",
                    ("A demonstration hypothesis with enough text.", 0.91, "user-a"),
                )
                assert cur.fetchone()[0] == "high"

                cur.execute(
                    "INSERT INTO hypotheses "
                    "(hypothesis_text, confidence, proposed_by_user_entra_id) "
                    "VALUES (%s, %s, %s) RETURNING confidence_tier",
                    ("Another hypothesis text long enough.", 0.65, "user-a"),
                )
                assert cur.fetchone()[0] == "medium"

                cur.execute(
                    "INSERT INTO hypotheses "
                    "(hypothesis_text, confidence, proposed_by_user_entra_id) "
                    "VALUES (%s, %s, %s) RETURNING confidence_tier",
                    ("Low-confidence hypothesis, still long enough.", 0.2, "user-a"),
                )
                assert cur.fetchone()[0] == "low"

            # ROLLBACK at end of `with conn.transaction()` block on exception,
            # or COMMIT on normal exit — we want ROLLBACK to keep DB clean.
            raise RuntimeError("_rollback_sentinel")
    except RuntimeError as exc:
        if str(exc) != "_rollback_sentinel":
            raise
    finally:
        conn.close()


def test_hypothesis_text_length_check() -> None:
    """Text under 10 chars should raise CheckViolation."""
    conn = _connect()
    try:
        with conn.cursor() as cur:
            _bypass_rls(cur)
            with pytest.raises(psycopg.errors.CheckViolation):
                cur.execute(
                    "INSERT INTO hypotheses "
                    "(hypothesis_text, confidence, proposed_by_user_entra_id) "
                    "VALUES (%s, %s, %s)",
                    ("short", 0.5, "user-a"),
                )
    finally:
        conn.rollback()
        conn.close()


def test_confidence_bounds_check() -> None:
    """Confidence > 1.0 should raise CheckViolation."""
    conn = _connect()
    try:
        with conn.cursor() as cur:
            _bypass_rls(cur)
            with pytest.raises(psycopg.errors.CheckViolation):
                cur.execute(
                    "INSERT INTO hypotheses "
                    "(hypothesis_text, confidence, proposed_by_user_entra_id) "
                    "VALUES (%s, %s, %s)",
                    ("An otherwise valid hypothesis text.", 1.5, "user-a"),
                )
    finally:
        conn.rollback()
        conn.close()


def test_rls_owner_sees_own_cross_portfolio() -> None:
    """user-a can see their own scope=NULL hypothesis; user-b cannot.

    RLS is forced on the table (FORCE ROW LEVEL SECURITY) so that even a
    DB-owner connection cannot bypass it during the SELECT phase.  The
    FORCE flag is always reset in the finally block.
    """
    unique_text = f"Cross-portfolio hypothesis by user-a {uuid.uuid4()}"
    hid: uuid.UUID

    # Insert as service (bypass RLS), then commit so the row is visible.
    conn = _connect()
    try:
        with conn.cursor() as cur:
            _bypass_rls(cur)
            cur.execute(
                "INSERT INTO hypotheses "
                "(hypothesis_text, confidence, proposed_by_user_entra_id) "
                "VALUES (%s, %s, %s) RETURNING id",
                (unique_text, 0.8, "user-a"),
            )
            hid = cur.fetchone()[0]
        conn.commit()

        # Force RLS to apply to ALL roles, including the DB owner, so the
        # assertions below are never vacuous regardless of connection role.
        with conn.cursor() as cur:
            cur.execute("ALTER TABLE hypotheses FORCE ROW LEVEL SECURITY")
        conn.commit()

        try:
            # user-a should see it.
            with conn.cursor() as cur:
                _set_user(cur, "user-a")
                cur.execute("SELECT id FROM hypotheses WHERE id = %s", (hid,))
                assert cur.fetchone() is not None, "user-a should see their own hypothesis"

            # user-b: count(*) with NO filter — any BYPASSRLS leak returns > 0.
            with conn.cursor() as cur:
                _set_user(cur, "user-b")
                cur.execute("SELECT count(*) FROM hypotheses")
                total_visible = cur.fetchone()[0]
                assert total_visible == 0, (
                    f"user-b should see zero hypotheses but got {total_visible}"
                )

            # Belt-and-suspenders: explicit id filter also returns nothing.
            with conn.cursor() as cur:
                _set_user(cur, "user-b")
                cur.execute("SELECT id FROM hypotheses WHERE id = %s", (hid,))
                assert cur.fetchone() is None, "user-b should not see user-a's hypothesis by id"
        finally:
            # Always restore the table to its default (no forced RLS).
            with conn.cursor() as cur:
                cur.execute("ALTER TABLE hypotheses NO FORCE ROW LEVEL SECURITY")
            conn.commit()
    finally:
        # Clean up the inserted row.
        with conn.cursor() as cur:
            _bypass_rls(cur)
            cur.execute("DELETE FROM hypotheses WHERE id = %s", (hid,))
        conn.commit()
        conn.close()


def test_status_change_emits_ingestion_event() -> None:
    """Updating hypotheses.status fires trg_hypotheses_status_event, which
    must INSERT a corresponding ingestion_events row of type
    'hypothesis_status_changed'. This contract is what update_hypothesis_status
    (services/agent-claw/src/tools/builtins/update_hypothesis_status.ts) relies
    on — the builtin only runs the UPDATE; the event emission is the trigger's
    job. If this test breaks, the kg_hypotheses projector silently stops
    seeing refutation cascades. Review §2.3.
    """
    conn = _connect()
    hid: uuid.UUID
    try:
        with conn.cursor() as cur:
            _bypass_rls(cur)

            cur.execute(
                "INSERT INTO hypotheses "
                "(hypothesis_text, confidence, proposed_by_user_entra_id, status) "
                "VALUES (%s, %s, %s, %s) RETURNING id",
                ("Hypothesis whose status we will refute.", 0.7, "user-a", "proposed"),
            )
            hid = cur.fetchone()[0]

            # Sanity: no event yet for this row.
            cur.execute(
                "SELECT count(*) FROM ingestion_events "
                "WHERE event_type = 'hypothesis_status_changed' "
                "  AND source_row_id = %s",
                (hid,),
            )
            assert cur.fetchone()[0] == 0

            # Trigger: UPDATE the status. trg_hypotheses_status_event should fire.
            cur.execute(
                "UPDATE hypotheses SET status = 'refuted' WHERE id = %s",
                (hid,),
            )

            cur.execute(
                "SELECT event_type, payload FROM ingestion_events "
                "WHERE source_row_id = %s "
                "ORDER BY created_at DESC LIMIT 1",
                (hid,),
            )
            row = cur.fetchone()
            assert row is not None, "trigger did not emit an ingestion_events row"
            event_type, payload = row
            assert event_type == "hypothesis_status_changed", event_type
            assert payload.get("new_status") == "refuted", payload
        # Rollback to keep DB clean.
        conn.rollback()
    finally:
        conn.close()


def test_citations_cascade_on_hypothesis_delete() -> None:
    """Deleting a hypothesis cascades to its hypothesis_citations."""
    conn = _connect()
    hid: uuid.UUID
    try:
        with conn.cursor() as cur:
            _bypass_rls(cur)

            cur.execute(
                "INSERT INTO hypotheses "
                "(hypothesis_text, confidence, proposed_by_user_entra_id) "
                "VALUES (%s, %s, %s) RETURNING id",
                ("Hypothesis that will be deleted.", 0.7, "user-a"),
            )
            hid = cur.fetchone()[0]

            cur.execute(
                "INSERT INTO hypothesis_citations (hypothesis_id, fact_id) VALUES (%s, %s)",
                (hid, str(uuid.uuid4())),
            )

            cur.execute("DELETE FROM hypotheses WHERE id = %s", (hid,))

            cur.execute(
                "SELECT count(*) FROM hypothesis_citations WHERE hypothesis_id = %s",
                (hid,),
            )
            assert cur.fetchone()[0] == 0, "citations should cascade-delete with hypothesis"
        # Rollback to keep DB clean — all assertions passed already.
        conn.rollback()
    finally:
        conn.close()
