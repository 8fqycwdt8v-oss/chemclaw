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
    """user-a can see their own scope=NULL hypothesis; user-b cannot."""
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

        # user-a should see it.
        with conn.cursor() as cur:
            _set_user(cur, "user-a")
            cur.execute("SELECT id FROM hypotheses WHERE id = %s", (hid,))
            assert cur.fetchone() is not None, "user-a should see their own hypothesis"

        # user-b should NOT see it (scope is NULL, not in their portfolio).
        with conn.cursor() as cur:
            _set_user(cur, "user-b")
            cur.execute("SELECT id FROM hypotheses WHERE id = %s", (hid,))
            assert cur.fetchone() is None, "user-b should not see user-a's hypothesis"
    finally:
        # Clean up the inserted row.
        with conn.cursor() as cur:
            _bypass_rls(cur)
            cur.execute("DELETE FROM hypotheses WHERE id = %s", (hid,))
        conn.commit()
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
