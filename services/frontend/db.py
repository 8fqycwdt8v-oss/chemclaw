"""Postgres access helpers for the Streamlit frontend.

A connection is opened per request; this keeps RLS `SET LOCAL` scoping safe.
For a dozen concurrent users this is fine; pool later if needed.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg.rows import dict_row

from services.frontend.settings import get_settings


@contextmanager
def connect(user_entra_id: str | None) -> Iterator[psycopg.Connection]:
    """Open a connection and set the RLS user context for its lifetime."""
    settings = get_settings()
    with psycopg.connect(settings.postgres_dsn, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT set_config('app.current_user_entra_id', %s, false)",
                (user_entra_id or "",),
            )
        yield conn


def list_projects(user_entra_id: str) -> list[dict[str, Any]]:
    with connect(user_entra_id) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, internal_id, name, therapeutic_area, phase, status
              FROM nce_projects
             ORDER BY internal_id
            """
        )
        return list(cur.fetchall())


def list_experiments(user_entra_id: str, project_internal_id: str) -> list[dict[str, Any]]:
    with connect(user_entra_id) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT e.id::text, e.eln_entry_id, e.date_performed,
                   e.operator_entra_id, e.yield_pct, e.outcome_status, ss.step_name
              FROM experiments e
              JOIN synthetic_steps ss ON ss.id = e.synthetic_step_id
              JOIN nce_projects p     ON p.id  = ss.nce_project_id
             WHERE p.internal_id = %s
             ORDER BY e.date_performed DESC NULLS LAST
             LIMIT 200
            """,
            (project_internal_id,),
        )
        return list(cur.fetchall())


def fetch_notifications(user_entra_id: str, limit: int = 20) -> list[dict[str, Any]]:
    with connect(user_entra_id) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, kind, payload, created_at, read_at
              FROM notifications
             WHERE user_entra_id = %s
             ORDER BY created_at DESC
             LIMIT %s
            """,
            (user_entra_id, limit),
        )
        return list(cur.fetchall())
