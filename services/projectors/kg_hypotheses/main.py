"""Projector: canonical hypotheses → Neo4j :Hypothesis nodes + :CITES edges.

Subscribes to `hypothesis_proposed` and `hypothesis_status_changed`.
Idempotent via uniqueness constraint on fact_id (shared with kg-experiments).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from typing import Any

import psycopg
from neo4j import AsyncGraphDatabase

from services.projectors.common.base import (
    BaseProjector,
    ProjectorSettings,
)

log = logging.getLogger("kg_hypotheses")

NAMESPACE_HYPOTHESIS = uuid.UUID("7b1d1d6a-1c2d-4e55-9c82-0a1e5e9a7f01")
NAMESPACE_CITES = uuid.UUID("5b8fbd8a-66f9-4b23-9a1c-1f6a0e6bb2a3")


class KgHypothesesProjector(BaseProjector):
    name = "kg_hypotheses"
    interested_event_types = ("hypothesis_proposed", "hypothesis_status_changed")

    def __init__(self, settings: ProjectorSettings) -> None:
        super().__init__(settings)
        self._neo4j_uri = os.environ["NEO4J_URI"]
        self._neo4j_user = os.environ.get("NEO4J_USER", "neo4j")
        self._neo4j_password = os.environ["NEO4J_PASSWORD"]
        self._driver = AsyncGraphDatabase.driver(
            self._neo4j_uri, auth=(self._neo4j_user, self._neo4j_password),
        )

    async def close(self) -> None:
        await self._driver.close()

    async def handle(
        self,
        *,
        event_id: str,
        event_type: str,
        source_table: str | None,
        source_row_id: str | None,
        payload: dict[str, Any],
    ) -> None:
        if event_type == "hypothesis_proposed":
            await self._handle_proposed(payload, source_row_id)
        elif event_type == "hypothesis_status_changed":
            await self._handle_status_changed(payload, source_row_id)
        # Unknown: BaseProjector acks; no action.

    async def _load_hypothesis(self, hid: str) -> dict[str, Any] | None:
        # Bi-temporal carve-out: this projector reads the *full* row state on
        # purpose, including refuted/archived hypotheses. Its job is to
        # project every state transition (proposal → refuted → archived) into
        # Neo4j; if we filtered `WHERE refuted_at IS NULL` here we would
        # silently drop the proposal projection on replay after a later
        # refutation. The read-time bi-temporal filter rule is for *consumer*
        # code (agent tools, projectors that read derived state); recording
        # projectors are exempt by design.
        async with await psycopg.AsyncConnection.connect(
            self.settings.postgres_dsn
        ) as conn, conn.cursor() as cur:
            await cur.execute(
                "SELECT id::text, hypothesis_text, confidence, confidence_tier, "
                "       scope_nce_project_id::text, created_at "
                "  FROM hypotheses WHERE id = %s::uuid",
                (hid,),
            )
            row = await cur.fetchone()
            if row is None:
                return None
            await cur.execute(
                "SELECT fact_id::text, citation_note "
                "  FROM hypothesis_citations WHERE hypothesis_id = %s::uuid",
                (hid,),
            )
            cites = await cur.fetchall()
        return {
            "id": row[0], "text": row[1], "confidence": float(row[2]),
            "confidence_tier": row[3], "scope_project_id": row[4],
            "created_at": row[5].isoformat() if hasattr(row[5], "isoformat") else str(row[5]),
            "citations": [(c[0], c[1]) for c in cites],
        }

    async def _handle_proposed(self, payload: dict[str, Any], source_row_id: str | None) -> None:
        hid = payload.get("hypothesis_id") or source_row_id
        if not hid:
            log.warning("hypothesis_proposed event missing hypothesis_id")
            return
        h = await self._load_hypothesis(hid)
        if h is None:
            log.warning("hypothesis %s not found (may have been deleted)", hid)
            return

        node_fact_id = str(uuid.uuid5(NAMESPACE_HYPOTHESIS, h["id"]))
        async with self._driver.session() as session:
            await session.run(
                """
                MERGE (n:Hypothesis {fact_id: $fact_id})
                  ON CREATE SET n.hypothesis_id = $hid,
                                n.text = $text,
                                n.confidence = $confidence,
                                n.confidence_tier = $tier,
                                n.scope_project_id = $scope,
                                n.created_at = $created_at,
                                n.valid_from = $created_at,
                                n.archived = false
                """,
                fact_id=node_fact_id,
                hid=h["id"], text=h["text"], confidence=h["confidence"],
                tier=h["confidence_tier"], scope=h["scope_project_id"],
                created_at=h["created_at"],
            )

            for fact_id, note in h["citations"]:
                edge_id = str(uuid.uuid5(NAMESPACE_CITES, f"{h['id']}|{fact_id}"))
                # If no :Fact node has this fact_id, fall back to an ungrounded placeholder.
                await session.run(
                    """
                    MATCH (h:Hypothesis {fact_id: $node_fact_id})
                    MERGE (f:Fact {fact_id: $fact_id})
                      ON CREATE SET f.ungrounded = true
                    MERGE (h)-[r:CITES {fact_id: $edge_id}]->(f)
                      ON CREATE SET r.note = $note
                    """,
                    node_fact_id=node_fact_id, fact_id=fact_id,
                    edge_id=edge_id, note=note,
                )

    async def _handle_status_changed(self, payload: dict[str, Any], source_row_id: str | None) -> None:
        hid = payload.get("hypothesis_id") or source_row_id
        if not hid:
            return
        # Bi-temporal carve-out (same rationale as `_load_hypothesis` above):
        # this read explicitly NEEDS to see status='refuted' rows — that is
        # exactly the state we are projecting. Filtering would no-op the
        # refutation handler.
        async with await psycopg.AsyncConnection.connect(
            self.settings.postgres_dsn
        ) as conn, conn.cursor() as cur:
            await cur.execute("SELECT status FROM hypotheses WHERE id = %s::uuid", (hid,))
            row = await cur.fetchone()
        if not row:
            return
        status = row[0]
        node_fact_id = str(uuid.uuid5(NAMESPACE_HYPOTHESIS, hid))
        async with self._driver.session() as session:
            if status == "refuted":
                # Idempotent: keep the original valid_to on replay so the
                # bi-temporal "refuted at" timestamp doesn't drift forward
                # every time the projector re-processes the same event.
                await session.run(
                    "MATCH (h:Hypothesis {fact_id: $fid}) "
                    "SET h.valid_to = CASE WHEN h.valid_to IS NULL THEN datetime() "
                    "ELSE h.valid_to END, "
                    "h.refuted = true",
                    fid=node_fact_id,
                )
                # Tranche 2 / C5 — refutation cascade.
                # When a hypothesis is refuted, every :CITES edge it owns is
                # itself a load-bearing claim that no longer holds. We close
                # the edges (additive bi-temporal: SET invalidated_at) so
                # downstream readers can filter them out, and emit one
                # fact_invalidated event per closed edge so future
                # consumers (Tranche 5 cache evictor, audit trail) can
                # react. The :Fact nodes themselves stay live because they
                # may be cited by other (non-refuted) hypotheses.
                #
                # Idempotent: the CASE WHEN guard means a replay does not
                # overwrite the original invalidated_at timestamp; the
                # Postgres event-emission below is gated on rowcount > 0
                # via the RETURN, so a no-op cascade emits no events.
                cascade_res = await session.run(
                    """
                    MATCH (h:Hypothesis {fact_id: $fid})-[r:CITES]->(f:Fact)
                    WHERE r.invalidated_at IS NULL
                    SET r.invalidated_at      = datetime(),
                        r.invalidation_reason = 'hypothesis_refuted'
                    RETURN r.fact_id AS edge_fact_id,
                           f.fact_id AS cited_fact_id
                    """,
                    fid=node_fact_id,
                )
                cascade_rows = [dict(rec) async for rec in cascade_res]
                if cascade_rows:
                    await self._emit_fact_invalidated_events(
                        hypothesis_id=hid, rows=cascade_rows,
                    )
            elif status == "archived":
                await session.run(
                    "MATCH (h:Hypothesis {fact_id: $fid}) SET h.archived = true",
                    fid=node_fact_id,
                )

    async def _emit_fact_invalidated_events(
        self, *, hypothesis_id: str, rows: list[dict[str, Any]],
    ) -> None:
        """Insert one fact_invalidated event per cascaded :CITES edge.

        Idempotency: the upstream cascade Cypher only returns rows for edges
        that were *just* invalidated (the WHERE r.invalidated_at IS NULL
        clause filters out edges already closed on a previous replay), so
        re-processing the same hypothesis_status_changed event emits zero
        new rows.

        Provenance: source_row_id points at the cascading hypothesis (UUID)
        and the payload carries both the cited fact_id (the :Fact node's
        fact_id, which the source-cache projector indexed) and the edge
        fact_id (the :CITES edge that was closed). Future consumers can pick
        whichever they need.
        """
        async with await psycopg.AsyncConnection.connect(
            self.settings.postgres_dsn
        ) as conn, conn.cursor() as cur:
            for r in rows:
                payload_obj = {
                    "fact_id":             r.get("cited_fact_id"),
                    "edge_fact_id":        r.get("edge_fact_id"),
                    "invalidated_by":      "hypothesis_refuted",
                    "invalidated_by_hypothesis_id": hypothesis_id,
                }
                await cur.execute(
                    """
                    INSERT INTO ingestion_events
                        (event_type, source_table, source_row_id, payload)
                    VALUES
                        ('fact_invalidated', 'hypotheses', %s::uuid, %s::jsonb)
                    """,
                    (hypothesis_id, json.dumps(payload_obj)),
                )
            await conn.commit()
        log.info(
            "cascaded refutation: hypothesis=%s edges_invalidated=%d",
            hypothesis_id,
            len(rows),
        )


def main() -> None:  # pragma: no cover — process entrypoint
    settings = ProjectorSettings()
    from services.mcp_tools.common.logging import configure_logging
    configure_logging(settings.projector_log_level, service="kg_hypotheses")
    proj = KgHypothesesProjector(settings)
    try:
        asyncio.run(proj.run())
    finally:
        asyncio.run(proj.close())


if __name__ == "__main__":
    main()
