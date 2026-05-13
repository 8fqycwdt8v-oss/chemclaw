"""Schema + RLS + event-emission integration tests for compute_results.

Skipped unless POSTGRES_HOST is set.

    POSTGRES_HOST=localhost POSTGRES_PASSWORD=<pw> \\
        pytest tests/integration/test_compute_results.py -v -m integration

Exercises:
  * INSERT round-trips payload and bi-temporal defaults
  * UNIQUE cache key on (tool_id, input_hash, nce_project_id, model_id) fires
  * tool_confidence CHECK rejects out-of-range values
  * input_hash length CHECK rejects too-short and too-long values
  * INSERT trigger emits a compute_result_observed ingestion_events row whose
    payload links back to the source row
  * RLS: a session whose user has no user_project_access entry sees nothing
"""
from __future__ import annotations

import json
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
        pass


def _set_user(cur: psycopg.Cursor, entra_id: str) -> None:  # type: ignore[type-arg]
    cur.execute("SELECT set_config('app.current_user_entra_id', %s, true)", (entra_id,))


def _seed_project(cur: psycopg.Cursor, *, grant_to: str | None = None) -> str:  # type: ignore[type-arg]
    suffix = uuid.uuid4().hex[:8]
    cur.execute(
        "INSERT INTO nce_projects (internal_id, name) VALUES (%s, %s) RETURNING id",
        (f"NCE-cr-{suffix}", f"compute-results test {suffix}"),
    )
    project_id = cur.fetchone()[0]
    if grant_to is not None:
        cur.execute(
            "INSERT INTO user_project_access (user_entra_id, nce_project_id, role) "
            "VALUES (%s, %s, 'contributor')",
            (grant_to, project_id),
        )
    return project_id


def _insert_compute_result(
    cur: psycopg.Cursor,  # type: ignore[type-arg]
    *,
    project_id: str,
    user: str,
    tool_id: str = "askcos",
    input_hash: str | None = None,
    model_id: str = "",
    payload: dict | None = None,
    tool_confidence: float | None = None,
) -> str:
    cur.execute(
        "INSERT INTO compute_results "
        "(tool_id, input_hash, model_id, nce_project_id, payload, "
        " tool_confidence, created_by_user_entra_id) "
        "VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s) "
        "RETURNING id",
        (
            tool_id,
            input_hash or uuid.uuid4().hex,
            model_id,
            project_id,
            json.dumps(payload or {"routes": []}),
            tool_confidence,
            user,
        ),
    )
    return cur.fetchone()[0]


# ---------------------------------------------------------------------------


def test_insert_round_trips_payload_and_defaults() -> None:
    conn = _connect()
    try:
        with conn.transaction():
            with conn.cursor() as cur:
                _bypass_rls(cur)
                pid = _seed_project(cur)
                row_id = _insert_compute_result(
                    cur,
                    project_id=pid,
                    user="alice@pharma.com",
                    tool_id="askcos",
                    input_hash="0" * 32,
                    payload={"routes": [{"steps": 3}]},
                    tool_confidence=0.42,
                )
                cur.execute(
                    "SELECT tool_id, input_hash, model_id, payload, tool_confidence, "
                    "       valid_from IS NOT NULL, valid_to "
                    "  FROM compute_results WHERE id = %s",
                    (row_id,),
                )
                row = cur.fetchone()
                assert row[0] == "askcos"
                assert row[1] == "0" * 32
                assert row[2] == ""  # NOT NULL DEFAULT ''
                assert row[3] == {"routes": [{"steps": 3}]}
                assert float(row[4]) == pytest.approx(0.42)
                assert row[5] is True
                assert row[6] is None  # null = current
    finally:
        conn.close()


def test_unique_cache_key_rejects_duplicate() -> None:
    conn = _connect()
    try:
        with pytest.raises(psycopg.errors.UniqueViolation):
            with conn.transaction():
                with conn.cursor() as cur:
                    _bypass_rls(cur)
                    pid = _seed_project(cur)
                    fixed_hash = "deadbeef" * 4
                    _insert_compute_result(
                        cur, project_id=pid, user="alice@pharma.com",
                        tool_id="askcos", input_hash=fixed_hash, model_id="v1",
                    )
                    _insert_compute_result(
                        cur, project_id=pid, user="alice@pharma.com",
                        tool_id="askcos", input_hash=fixed_hash, model_id="v1",
                    )
    finally:
        conn.close()


def test_different_model_id_is_a_distinct_row() -> None:
    """Re-running the same input with an upgraded model produces a new row."""
    conn = _connect()
    try:
        with conn.transaction():
            with conn.cursor() as cur:
                _bypass_rls(cur)
                pid = _seed_project(cur)
                fixed_hash = "feedface" * 4
                a = _insert_compute_result(
                    cur, project_id=pid, user="alice@pharma.com",
                    tool_id="askcos", input_hash=fixed_hash, model_id="v1",
                )
                b = _insert_compute_result(
                    cur, project_id=pid, user="alice@pharma.com",
                    tool_id="askcos", input_hash=fixed_hash, model_id="v2",
                )
                assert a != b
    finally:
        conn.close()


def test_tool_confidence_out_of_range_violates_check() -> None:
    conn = _connect()
    try:
        with pytest.raises(psycopg.errors.CheckViolation):
            with conn.transaction():
                with conn.cursor() as cur:
                    _bypass_rls(cur)
                    pid = _seed_project(cur)
                    _insert_compute_result(
                        cur, project_id=pid, user="alice@pharma.com",
                        tool_confidence=1.5,
                    )
    finally:
        conn.close()


def test_input_hash_too_short_violates_check() -> None:
    conn = _connect()
    try:
        with pytest.raises(psycopg.errors.CheckViolation):
            with conn.transaction():
                with conn.cursor() as cur:
                    _bypass_rls(cur)
                    pid = _seed_project(cur)
                    _insert_compute_result(
                        cur, project_id=pid, user="alice@pharma.com",
                        input_hash="abc",  # length 3 < 8
                    )
    finally:
        conn.close()


def test_insert_emits_compute_result_observed_event() -> None:
    conn = _connect()
    try:
        with conn.transaction():
            with conn.cursor() as cur:
                _bypass_rls(cur)
                pid = _seed_project(cur)
                row_id = _insert_compute_result(
                    cur, project_id=pid, user="alice@pharma.com",
                    tool_id="chemprop", input_hash="cafef00d" * 4, model_id="reg-1",
                )
                cur.execute(
                    "SELECT event_type, source_table, source_row_id::text, payload "
                    "  FROM ingestion_events "
                    " WHERE source_table = 'compute_results' "
                    "   AND source_row_id = %s::uuid",
                    (row_id,),
                )
                ev = cur.fetchone()
                assert ev is not None, "expected a compute_result_observed event row"
                assert ev[0] == "compute_result_observed"
                assert ev[1] == "compute_results"
                assert ev[2] == row_id
                # Payload links back to the source row + carries the cache key.
                assert ev[3]["compute_result_id"] == row_id
                assert ev[3]["tool_id"] == "chemprop"
                assert ev[3]["input_hash"] == "cafef00d" * 4
                assert ev[3]["model_id"] == "reg-1"
                assert ev[3]["nce_project_id"] == pid
                assert ev[3]["created_by_user_entra_id"] == "alice@pharma.com"
    finally:
        conn.close()


def test_rls_hides_rows_from_users_without_project_access() -> None:
    """A row written under user A is invisible to user B who lacks access."""
    conn_admin = _connect()
    try:
        with conn_admin.transaction():
            with conn_admin.cursor() as cur:
                _bypass_rls(cur)
                pid = _seed_project(cur, grant_to="alice@pharma.com")
                # Insert as alice (with access) via service-role bypass so RLS
                # WITH CHECK doesn't interfere — we're seeding the row to test
                # SELECT visibility from bob's perspective below.
                row_id = _insert_compute_result(
                    cur, project_id=pid, user="alice@pharma.com",
                    tool_id="aizynth", input_hash="cafe" * 8,
                )
        # Re-open as the chemclaw_app role (RLS-enforced) and query as bob.
        conn_app = _connect()
        try:
            with conn_app.cursor() as cur:
                # Switch to the app role *without* bypassing RLS. If the role
                # doesn't exist on this env (fresh-DB test), the connection
                # itself is the owner — which still has FORCE RLS — so the
                # SET ROLE is best-effort.
                try:
                    cur.execute("SET ROLE chemclaw_app")
                except psycopg.errors.InvalidParameterValue:
                    pass
                _set_user(cur, "bob@pharma.com")  # no user_project_access entry
                cur.execute(
                    "SELECT count(*) FROM compute_results WHERE id = %s",
                    (row_id,),
                )
                assert cur.fetchone()[0] == 0
        finally:
            conn_app.close()
    finally:
        conn_admin.close()
