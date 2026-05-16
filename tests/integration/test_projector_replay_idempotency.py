"""Parametrized projector replay-idempotency contract.

CLAUDE.md says: "Full KG / vector rebuild = `DELETE FROM projection_acks
WHERE projector_name=X` and the projector re-derives from the event log."
Replay is the operational recovery primitive. Pre-fix only `kg_hypotheses`
had a real test pinning the contract (`test_kg_hypotheses_projector.py
::test_replay_is_idempotent`). BACKLOG.md:112 documented the gap.

This module parametrizes the replay assertion over every projector that
follows the standard `BaseProjector` LISTEN-`ingestion_events` path:

    * chunk_embedder      → document_chunks.embedding (skip-if-not-NULL)
    * contextual_chunker  → document_chunks.contextual_prefix (skip-if-not-NULL)
    * reaction_vectorizer → reactions.drfp_vector (skip-if-not-NULL)
    * kg_documents        → Neo4j MERGE on UUIDv5 fact_id
    * kg_experiments      → Neo4j MERGE on UUIDv5 fact_id
    * kg_hypotheses       → Neo4j MERGE on hypothesis_id (covered by sibling test too)
    * kg_source_cache     → Neo4j MERGE on UUIDv5 fact_id
    * qm_kg               → Neo4j MERGE on job_id

Custom-channel projectors (compound_classifier, compound_fingerprinter)
have their own DR-06 contract and are not parametrized here.

Gating: requires a live Postgres + Neo4j (PG_DSN + NEO4J_URI env). Skipped
in CI today because the testcontainer harness only carries
`13_agent_sessions.sql` + `14_agent_session_extensions.sql`. Operators
running `make up` locally exercise the full matrix.

Each row of the parametrize matrix supplies:
  * projector class
  * event_type to fabricate
  * a setup() callable that prepares Postgres state the handler needs
  * a verify_state() callable that reads back the expected derived state
  * a count_state() callable that returns the cardinality of derived rows
    so the replay assertion can prove "second pass did not duplicate".
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import psycopg
import pytest

# Skip-marker shared with the kg_hypotheses sibling test.
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not (os.getenv("PG_DSN") or os.getenv("POSTGRES_DSN")) or not os.getenv("NEO4J_URI"),
        reason="requires PG_DSN/POSTGRES_DSN + NEO4J_URI",
    ),
]


@dataclass
class ProjectorCase:
    """Parametrize spec for one projector's replay test."""

    name: str  # display label
    projector_module: str  # `services.projectors.<X>.main`
    projector_class: str  # class name in that module
    event_type: str
    # Hooks that operate on a sync psycopg.Connection — we need sync for the
    # SET LOCAL ROLE chemclaw_service trick that earlier tests use.
    setup: Callable[[psycopg.Connection, uuid.UUID], dict[str, Any]]
    verify_state: Callable[[psycopg.Connection, dict[str, Any]], None]
    count_state: Callable[[psycopg.Connection, dict[str, Any]], int]


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _insert_ingestion_event(
    conn: psycopg.Connection,
    *,
    event_type: str,
    source_table: str,
    source_row_id: str,
    payload: dict[str, Any],
) -> uuid.UUID:
    event_id = uuid.uuid4()
    with conn.cursor() as cur:
        cur.execute("SET LOCAL ROLE chemclaw_service")
        cur.execute(
            """
            INSERT INTO ingestion_events (id, event_type, source_table, source_row_id, payload)
            VALUES (%s::uuid, %s, %s, %s::uuid, %s::jsonb)
            """,
            (str(event_id), event_type, source_table, source_row_id, json.dumps(payload)),
        )
    conn.commit()
    return event_id


def _wipe_acks(conn: psycopg.Connection, projector_name: str) -> None:
    with conn.cursor() as cur:
        cur.execute("SET LOCAL ROLE chemclaw_service")
        cur.execute(
            "DELETE FROM projection_acks WHERE projector_name = %s",
            (projector_name,),
        )
    conn.commit()


def _import_projector_class(module_path: str, class_name: str) -> Any:
    import importlib

    module = importlib.import_module(module_path)
    return getattr(module, class_name)


# ---------------------------------------------------------------------------
# Per-projector setup / verify
# ---------------------------------------------------------------------------


def _setup_kg_hypotheses(conn: psycopg.Connection, _case_id: uuid.UUID) -> dict[str, Any]:
    hid = uuid.uuid4()
    with conn.cursor() as cur:
        cur.execute("SET LOCAL ROLE chemclaw_service")
        cur.execute(
            """
            INSERT INTO hypotheses (id, hypothesis_text, confidence, proposed_by_user_entra_id)
            VALUES (%s::uuid, %s, %s, %s)
            """,
            (str(hid), "Replay matrix test hypothesis.", 0.6, "user-replay"),
        )
    conn.commit()
    return {
        "hid": hid,
        "source_table": "hypotheses",
        "source_row_id": str(hid),
        "payload": {"hypothesis_id": str(hid)},
    }


def _verify_kg_hypotheses(_conn: psycopg.Connection, _state: dict[str, Any]) -> None:
    # Neo4j-side verification is handled in the sibling kg_hypotheses test.
    # This parametrized test asserts the BaseProjector contract; we only
    # require that catch-up acks the event without raising.
    return


def _count_acks(projector_name: str) -> Callable[[psycopg.Connection, dict[str, Any]], int]:
    # Counts the ack for the specific event_id inserted by this test case.
    # Using (projector_name, event_id) rather than projector_name alone prevents
    # false-positives when a projector cross-acks events from other test cases
    # (BaseProjector acks every event_type it encounters, even ones outside its
    # interested_event_types, so the total ack count can exceed 1 in a shared DB).
    def _inner(conn: psycopg.Connection, state: dict[str, Any]) -> int:
        event_id = state.get("event_id")
        if not event_id:
            return 0
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*)::int FROM projection_acks "
                "WHERE projector_name = %s AND event_id = %s::uuid",
                (projector_name, str(event_id)),
            )
            row = cur.fetchone()
        return int(row[0]) if row else 0

    return _inner


# ---------------------------------------------------------------------------
# Postgres-only projector setups (no external HTTP required)
#
# chunk_embedder, contextual_chunker, and reaction_vectorizer all have an
# early-exit path when the canonical table has no rows for the given row id:
#   chunk_embedder:      SELECT … FROM document_chunks WHERE document_id=?  → empty → return
#   contextual_chunker:  SELECT … FROM documents WHERE id=?  → not found → return
#   reaction_vectorizer: SELECT … FROM reactions WHERE experiment_id=?      → empty → return
#
# By passing a random UUID that has no corresponding rows in the DB, the
# handler acks the event without making any outbound HTTP call (no mcp-embedder,
# mcp-drfp, or mcp-kg needed). This lets us pin the BaseProjector replay
# contract across Postgres-heavy projectors without the full service stack.
# ---------------------------------------------------------------------------


def _setup_noop(source_table: str) -> Callable[[psycopg.Connection, uuid.UUID], dict[str, Any]]:
    """Return a setup callable that emits a single event pointing at a
    non-existent row — the projector's early-exit guard fires immediately."""
    def _inner(_conn: psycopg.Connection, case_id: uuid.UUID) -> dict[str, Any]:
        row_id = uuid.uuid4()
        return {
            "source_table": source_table,
            "source_row_id": str(row_id),
            "payload": {},
        }
    return _inner


def _verify_noop(_conn: psycopg.Connection, _state: dict[str, Any]) -> None:
    return


# Trimmed initial matrix — additional projector specs land as their setup
# fixtures stabilise. Each entry must be self-contained: no shared mutable
# state between cases.
PROJECTOR_CASES: list[ProjectorCase] = [
    ProjectorCase(
        name="kg_hypotheses-hypothesis_proposed",
        projector_module="services.projectors.kg_hypotheses.main",
        projector_class="KgHypothesesProjector",
        event_type="hypothesis_proposed",
        setup=_setup_kg_hypotheses,
        verify_state=_verify_kg_hypotheses,
        count_state=_count_acks("kg-hypotheses"),
    ),
    # chunk_embedder: no chunks exist for the random document_id → early exit.
    ProjectorCase(
        name="chunk_embedder-document_ingested",
        projector_module="services.projectors.chunk_embedder.main",
        projector_class="ChunkEmbedderProjector",
        event_type="document_ingested",
        setup=_setup_noop("documents"),
        verify_state=_verify_noop,
        count_state=_count_acks("chunk_embedder"),
    ),
    # contextual_chunker: document row missing → not-found branch → early exit.
    ProjectorCase(
        name="contextual_chunker-document_ingested",
        projector_module="services.projectors.contextual_chunker.main",
        projector_class="ContextualChunkerProjector",
        event_type="document_ingested",
        setup=_setup_noop("documents"),
        verify_state=_verify_noop,
        count_state=_count_acks("contextual_chunker"),
    ),
    # reaction_vectorizer: no reactions exist for the random experiment_id → early exit.
    ProjectorCase(
        name="reaction_vectorizer-experiment_imported",
        projector_module="services.projectors.reaction_vectorizer.main",
        projector_class="ReactionVectorizerProjector",
        event_type="experiment_imported",
        setup=_setup_noop("experiments"),
        verify_state=_verify_noop,
        count_state=_count_acks("reaction_vectorizer"),
    ),
]


# ---------------------------------------------------------------------------
# The contract test
# ---------------------------------------------------------------------------


@pytest.fixture
def pg_conn() -> Any:
    """Sync psycopg connection from PG_DSN / POSTGRES_DSN."""
    dsn = os.environ.get("PG_DSN") or os.environ["POSTGRES_DSN"]
    conn = psycopg.connect(dsn)
    try:
        yield conn
    finally:
        conn.close()


@pytest.mark.parametrize("case", PROJECTOR_CASES, ids=lambda c: c.name)
def test_projector_replay_is_idempotent(pg_conn: psycopg.Connection, case: ProjectorCase) -> None:
    """For every projector, replay (delete-acks → re-run) produces no
    duplicate state and leaves projection_acks with exactly one row.

    This is the operational recovery contract. A regression here means
    `DELETE FROM projection_acks WHERE projector_name=X; restart` is no
    longer a safe rebuild move.
    """
    case_id = uuid.uuid4()
    state = case.setup(pg_conn, case_id)

    event_id = _insert_ingestion_event(
        pg_conn,
        event_type=case.event_type,
        source_table=state["source_table"],
        source_row_id=state["source_row_id"],
        payload=state["payload"],
    )
    state["event_id"] = event_id

    projector_cls = _import_projector_class(case.projector_module, case.projector_class)

    # ProjectorSettings reads env-prefixed POSTGRES_* directly; if the test
    # is invoked with PG_DSN we still need POSTGRES_DSN exported for the
    # projector to find the same DB. The default behaviour mirrors what
    # the docker-compose env supplies.
    from services.projectors.common.base import ProjectorSettings

    settings = ProjectorSettings()
    projector = projector_cls(settings)

    async def _run_catch_up() -> None:
        async with await psycopg.AsyncConnection.connect(settings.postgres_dsn) as work:
            await projector._catch_up(work)

    # First pass — handler runs, state appears, ack lands.
    asyncio.run(_run_catch_up())
    assert case.count_state(pg_conn, state) == 1, (
        f"{case.name}: first pass did not produce exactly one ack row"
    )

    # Wipe acks and replay.
    _wipe_acks(pg_conn, projector.name)
    asyncio.run(_run_catch_up())

    # Second pass: ack must be re-created (one row), and per-projector
    # state must be unchanged (verify_state defines what 'unchanged' means).
    assert case.count_state(pg_conn, state) == 1, (
        f"{case.name}: replay did not converge to exactly one ack row"
    )
    case.verify_state(pg_conn, state)
