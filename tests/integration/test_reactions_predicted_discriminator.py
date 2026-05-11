"""Schema integration tests for reactions.is_predicted discriminator.

Skipped unless POSTGRES_HOST is set.

    POSTGRES_HOST=localhost POSTGRES_PASSWORD=<pw> \\
        pytest tests/integration/test_reactions_predicted_discriminator.py -v -m integration

Exercises:
  - default (is_predicted=FALSE, predictor cols NULL) inserts cleanly
  - is_predicted=TRUE without predictor_tool_id violates the CHECK
  - is_predicted=FALSE with a predictor_tool_id violates the CHECK
  - is_predicted=TRUE with predictor_tool_id (model_id NULL) inserts cleanly
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
        pass


def _seed_experiment(cur: psycopg.Cursor) -> str:  # type: ignore[type-arg]
    """Build the nce_project → synthetic_step → experiment FK chain."""
    suffix = uuid.uuid4().hex[:8]
    cur.execute(
        "INSERT INTO nce_projects (internal_id, name) VALUES (%s, %s) RETURNING id",
        (f"NCE-test-{suffix}", f"reactions-discriminator test {suffix}"),
    )
    project_id = cur.fetchone()[0]
    cur.execute(
        "INSERT INTO synthetic_steps (nce_project_id, step_index, step_name) "
        "VALUES (%s, %s, %s) RETURNING id",
        (project_id, 1, "test step"),
    )
    step_id = cur.fetchone()[0]
    cur.execute(
        "INSERT INTO experiments (synthetic_step_id, eln_entry_id, procedure_text) "
        "VALUES (%s, %s, %s) RETURNING id",
        (step_id, f"ELN-test-{suffix}", "n/a"),
    )
    return cur.fetchone()[0]


# ---------------------------------------------------------------------------


def test_default_inserts_with_is_predicted_false() -> None:
    conn = _connect()
    try:
        with conn.transaction():
            with conn.cursor() as cur:
                _bypass_rls(cur)
                exp_id = _seed_experiment(cur)
                cur.execute(
                    "INSERT INTO reactions (experiment_id, rxn_smiles) "
                    "VALUES (%s, %s) "
                    "RETURNING is_predicted, predictor_tool_id, predictor_model_id",
                    (exp_id, "CCO>>CCO"),
                )
                row = cur.fetchone()
                assert row[0] is False
                assert row[1] is None
                assert row[2] is None
    finally:
        conn.close()


def test_predicted_true_requires_tool_id() -> None:
    conn = _connect()
    try:
        with pytest.raises(psycopg.errors.CheckViolation):
            with conn.transaction():
                with conn.cursor() as cur:
                    _bypass_rls(cur)
                    exp_id = _seed_experiment(cur)
                    cur.execute(
                        "INSERT INTO reactions "
                        "(experiment_id, rxn_smiles, is_predicted) "
                        "VALUES (%s, %s, TRUE)",
                        (exp_id, "CCO>>CCO"),
                    )
    finally:
        conn.close()


def test_predicted_false_rejects_predictor_columns() -> None:
    conn = _connect()
    try:
        with pytest.raises(psycopg.errors.CheckViolation):
            with conn.transaction():
                with conn.cursor() as cur:
                    _bypass_rls(cur)
                    exp_id = _seed_experiment(cur)
                    cur.execute(
                        "INSERT INTO reactions "
                        "(experiment_id, rxn_smiles, is_predicted, predictor_tool_id) "
                        "VALUES (%s, %s, FALSE, %s)",
                        (exp_id, "CCO>>CCO", "askcos"),
                    )
    finally:
        conn.close()


def test_predicted_true_with_tool_id_inserts() -> None:
    conn = _connect()
    try:
        with conn.transaction():
            with conn.cursor() as cur:
                _bypass_rls(cur)
                exp_id = _seed_experiment(cur)
                cur.execute(
                    "INSERT INTO reactions "
                    "(experiment_id, rxn_smiles, is_predicted, "
                    " predictor_tool_id, predictor_model_id) "
                    "VALUES (%s, %s, TRUE, %s, %s) "
                    "RETURNING is_predicted, predictor_tool_id, predictor_model_id",
                    (exp_id, "CCO>>CCO", "askcos", "askcos/v2.1"),
                )
                row = cur.fetchone()
                assert row[0] is True
                assert row[1] == "askcos"
                assert row[2] == "askcos/v2.1"
    finally:
        conn.close()
