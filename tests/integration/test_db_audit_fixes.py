"""Integration tests for db/init/16_db_audit_fixes.sql.

Skipped unless POSTGRES_HOST is set in the environment. Run with:

    POSTGRES_HOST=localhost POSTGRES_PASSWORD=<pw> \
        pytest tests/integration/test_db_audit_fixes.py -v -m integration

Requires `make up && make db.init` to have applied 16_db_audit_fixes.sql
on top of the v1.0.0-claw schema.

Each test focuses on one finding from the audit so a regression points
at the exact behavior that broke.
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
    try:
        cur.execute("SET LOCAL ROLE chemclaw_service")
    except psycopg.errors.InvalidParameterValue:
        # Falls through when the connection is already chemclaw owner.
        pass


def _set_user(cur: psycopg.Cursor, entra_id: str) -> None:  # type: ignore[type-arg]
    cur.execute("SELECT set_config('app.current_user_entra_id', %s, true)", (entra_id,))


def _skip_if_table_missing(qualified_name: str) -> None:
    """pytest.skip when the table isn't present (partial init / CI env)."""
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass(%s)", (qualified_name,))
            if cur.fetchone()[0] is None:
                pytest.skip(f"{qualified_name} not present in this DB (partial init)")
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 1. FORCE ROW LEVEL SECURITY is enabled on the audit-targeted tables.
# ---------------------------------------------------------------------------

FORCE_RLS_TABLES = (
    "paperclip_state",
    "research_reports",
    "hypotheses",
    "hypothesis_citations",
    "skill_library",
    "artifacts",
    "forged_tool_tests",
    "forged_tool_validation_runs",
    "shadow_run_scores",
    "skill_promotion_events",
)


@pytest.mark.parametrize("table", FORCE_RLS_TABLES)
def test_force_rls_enabled(table: str) -> None:
    _skip_if_table_missing(f"public.{table}")
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
                "WHERE relname = %s AND relnamespace = 'public'::regnamespace",
                (table,),
            )
            row = cur.fetchone()
            assert row is not None, f"{table} not found in pg_class"
            row_security, force_row_security = row
            assert row_security, f"{table} should have ROW LEVEL SECURITY enabled"
            assert force_row_security, f"{table} should have FORCE ROW LEVEL SECURITY enabled"
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 2. Functions have an explicit search_path (search_path hijack defence).
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "schema,function_name",
    [
        ("public", "set_updated_at"),
        ("public", "notify_ingestion_event"),
        ("public", "agent_sessions_regen_etag"),
        ("mock_eln", "set_entry_modified_at"),
    ],
)
def test_function_has_explicit_search_path(schema: str, function_name: str) -> None:
    conn = _connect()
    try:
        with conn.cursor() as cur:
            # Match the migration's pronargs=0 filter — the migration only
            # pins search_path on the zero-arg trigger functions. Without
            # this filter, an overloaded variant could pass the test on the
            # zero-arg row while the new variant remained vulnerable.
            cur.execute(
                "SELECT proconfig FROM pg_proc p "
                "JOIN pg_namespace n ON n.oid = p.pronamespace "
                "WHERE p.proname = %s AND n.nspname = %s AND p.pronargs = 0",
                (function_name, schema),
            )
            row = cur.fetchone()
            if row is None:
                pytest.skip(f"{schema}.{function_name} not present in this DB")
            (proconfig,) = row
            assert proconfig is not None, (
                f"{schema}.{function_name} has no proconfig — search_path is "
                f"caller-controlled and could be hijacked"
            )
            assert any(
                cfg.startswith("search_path=") for cfg in proconfig
            ), f"{schema}.{function_name} proconfig {proconfig!r} lacks search_path"
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 3. Indexes added by the audit fix are present.
# ---------------------------------------------------------------------------

# Indexes the migration creates. Note: 13_agent_sessions.sql already provides
# idx_agent_sessions_expires; we deliberately do NOT add a composite
# (expires_at, created_at) — see migration block 5 for the rationale.
EXPECTED_INDEXES = (
    ("public",   "idx_ingestion_events_payload_gin"),
    ("public",   "idx_projection_acks_projector_name"),
    ("public",   "idx_research_reports_trace_id"),
    ("public",   "idx_compounds_chebi_id"),
    ("public",   "idx_compounds_pubchem_cid"),
    ("public",   "idx_paperclip_session_id"),
    ("public",   "idx_artifacts_owner_maturity"),
    ("public",   "idx_corrections_unapplied"),
    ("public",   "idx_corrections_user"),
    ("mock_eln", "idx_mock_eln_entries_project_status_modified"),
)


# Map an index back to the table whose presence gates it. Indexes whose
# parent table is missing should skip, not fail (partial init / CI env).
_INDEX_PARENT_TABLE = {
    "idx_ingestion_events_payload_gin":             "public.ingestion_events",
    "idx_projection_acks_projector_name":           "public.projection_acks",
    "idx_research_reports_trace_id":                "public.research_reports",
    "idx_compounds_chebi_id":                       "public.compounds",
    "idx_compounds_pubchem_cid":                    "public.compounds",
    "idx_paperclip_session_id":                     "public.paperclip_state",
    "idx_artifacts_owner_maturity":                 "public.artifacts",
    "idx_corrections_unapplied":                    "public.corrections",
    "idx_corrections_user":                         "public.corrections",
    "idx_mock_eln_entries_project_status_modified": "mock_eln.entries",
}


@pytest.mark.parametrize("schema,index_name", EXPECTED_INDEXES)
def test_audit_index_exists(schema: str, index_name: str) -> None:
    parent = _INDEX_PARENT_TABLE.get(index_name)
    if parent:
        _skip_if_table_missing(parent)
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM pg_indexes WHERE schemaname = %s AND indexname = %s",
                (schema, index_name),
            )
            assert cur.fetchone() is not None, f"{schema}.{index_name} missing"
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 4. CHECK constraints — agent_sessions invariants.
#
# Each test wraps its work in `with conn.transaction():` (psycopg3 context
# manager that issues BEGIN on entry and ROLLBACK on exit when the inner
# block raises, COMMIT otherwise). This is robust against connection-error
# cleanup paths and avoids the "rollback on already-aborted connection"
# class of test infrastructure bugs.
# ---------------------------------------------------------------------------

def test_agent_sessions_awaiting_question_length() -> None:
    """awaiting_question > 4000 chars rejected."""
    with _connect() as conn, conn.cursor() as cur:
        _bypass_rls(cur)
        with pytest.raises(psycopg.errors.CheckViolation):
            with conn.transaction():
                cur.execute(
                    "INSERT INTO agent_sessions (user_entra_id, awaiting_question) "
                    "VALUES (%s, %s)",
                    ("user-a", "x" * 4001),
                )


def test_agent_sessions_auto_resume_count_within_cap() -> None:
    """auto_resume_count > auto_resume_cap rejected."""
    with _connect() as conn, conn.cursor() as cur:
        _bypass_rls(cur)
        with pytest.raises(psycopg.errors.CheckViolation):
            with conn.transaction():
                cur.execute(
                    "INSERT INTO agent_sessions "
                    "(user_entra_id, auto_resume_count, auto_resume_cap) "
                    "VALUES (%s, %s, %s)",
                    ("user-a", 11, 10),
                )


def test_agent_sessions_auto_resume_count_at_cap_boundary_allowed() -> None:
    """count == cap is the boundary case (last allowed resume). The constraint
    must permit equality so the reanimator can write the final increment."""
    with _connect() as conn, conn.cursor() as cur:
        _bypass_rls(cur)
        # Inner transaction is rolled back at the end so we don't leak the
        # row to other tests; the INSERT must succeed (no exception).
        with pytest.raises(_RollbackSentinel):
            with conn.transaction():
                cur.execute(
                    "INSERT INTO agent_sessions "
                    "(user_entra_id, auto_resume_count, auto_resume_cap) "
                    "VALUES (%s, %s, %s) RETURNING id",
                    ("user-a", 10, 10),
                )
                assert cur.fetchone()[0] is not None
                raise _RollbackSentinel  # discard the row


def test_agent_sessions_token_counters_nonneg() -> None:
    """Negative token counters rejected."""
    with _connect() as conn, conn.cursor() as cur:
        _bypass_rls(cur)
        with pytest.raises(psycopg.errors.CheckViolation):
            with conn.transaction():
                cur.execute(
                    "INSERT INTO agent_sessions "
                    "(user_entra_id, session_input_tokens) VALUES (%s, %s)",
                    ("user-a", -1),
                )


def test_agent_sessions_finish_reason_check() -> None:
    """Unknown finish_reason rejected."""
    with _connect() as conn, conn.cursor() as cur:
        _bypass_rls(cur)
        with pytest.raises(psycopg.errors.CheckViolation):
            with conn.transaction():
                cur.execute(
                    "INSERT INTO agent_sessions "
                    "(user_entra_id, last_finish_reason) VALUES (%s, %s)",
                    ("user-a", "this-is-not-a-real-reason"),
                )


class _RollbackSentinel(Exception):
    """Raised inside a happy-path test to force the surrounding
    `conn.transaction()` to rollback so we don't leak the inserted row."""


# ---------------------------------------------------------------------------
# 5. RLS — research_reports owner-scoped FOR ALL.
# ---------------------------------------------------------------------------

def test_research_reports_owner_isolation() -> None:
    """user-a inserts; user-b sees nothing through RLS."""
    _skip_if_table_missing("public.research_reports")
    unique_query = f"Audit isolation test {uuid.uuid4()}"
    rid: uuid.UUID

    conn = _connect()
    try:
        with conn.cursor() as cur:
            _bypass_rls(cur)
            cur.execute(
                "INSERT INTO research_reports (user_entra_id, query, markdown) "
                "VALUES (%s, %s, %s) RETURNING id",
                ("user-a", unique_query, "# Body"),
            )
            rid = cur.fetchone()[0]
        conn.commit()

        with conn.cursor() as cur:
            _set_user(cur, "user-a")
            cur.execute("SELECT id FROM research_reports WHERE id = %s", (rid,))
            assert cur.fetchone() is not None, "user-a should see their own report"

        with conn.cursor() as cur:
            _set_user(cur, "user-b")
            cur.execute("SELECT id FROM research_reports WHERE id = %s", (rid,))
            assert cur.fetchone() is None, "user-b should NOT see user-a's report"
    finally:
        with conn.cursor() as cur:
            _bypass_rls(cur)
            cur.execute("DELETE FROM research_reports WHERE id = %s", (rid,))
        conn.commit()
        conn.close()


def test_research_reports_with_check_blocks_cross_user_insert() -> None:
    """user-b cannot INSERT a row attributed to user-a (WITH CHECK gate)."""
    _skip_if_table_missing("public.research_reports")
    conn = _connect()
    try:
        with conn.cursor() as cur:
            _set_user(cur, "user-b")
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                cur.execute(
                    "INSERT INTO research_reports (user_entra_id, query, markdown) "
                    "VALUES (%s, %s, %s)",
                    ("user-a", "stolen-attribution", "# body"),
                )
    finally:
        conn.rollback()
        conn.close()


# ---------------------------------------------------------------------------
# 6. paperclip_state token columns are BIGINT.
# ---------------------------------------------------------------------------

def test_paperclip_state_token_columns_are_bigint() -> None:
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT column_name, data_type FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'paperclip_state' "
                "AND column_name IN ('est_tokens', 'actual_tokens') "
                "ORDER BY column_name"
            )
            rows = cur.fetchall()
            assert rows == [
                ("actual_tokens", "bigint"),
                ("est_tokens", "bigint"),
            ], f"expected BIGINT for both token columns, got {rows!r}"
    finally:
        conn.close()
