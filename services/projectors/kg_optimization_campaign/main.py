"""Projector: optimization rounds → Neo4j :OptimizationRound nodes + edges.

Subscribes to:
  optimization_round_proposed    — INSERT on optimization_rounds (proposals only)
  optimization_results_ingested  — UPDATE when measured_outcomes is populated

Graph model:
  (:OptimizationCampaign {campaign_id, name, strategy, acquisition, status,
                          nce_project_id})
    -[:MEASURED_BY {round_index}]->
  (:OptimizationRound {fact_id, round_id, campaign_id, round_index,
                       n_proposals, n_outcomes?, proposed_at, results_at?})

Both nodes are MERGE-idempotent on their fact_id (UUIDv5 derived from the
Postgres UUID). The :OptimizationCampaign node is upserted on every round
event so the KG reflects the latest campaign status without requiring a
separate campaign-lifecycle event subscription.

Analysts can then ask "which BO rounds inform this compound's profile" by
walking:
  MATCH (:Compound {inchikey: $k})<-[:INVOLVES]-(:OptimizationRound)
  ...
(once the compound-involvement edges from the proposals JSONB are added in
a follow-up Phase; today only the round spine is written).
"""
from __future__ import annotations

import asyncio
import logging
import re
import uuid
from typing import Any

import psycopg

from services.mcp_tools.common.logging import configure_logging
from services.projectors.common.base import (
    BaseProjector,
    ProjectorSettings,
)
from services.projectors.common.neo4j_client import SYSTEM_GROUP_ID, Neo4jClient

log = logging.getLogger("projector.kg_optimization_campaign")

# Defense-in-depth: only alphanumerics, hyphens, and underscores in group_id.
_GROUP_ID_RE = re.compile(r"^[A-Za-z0-9_\-]+$")


def _safe_group_id(gid: str | None) -> str:
    if gid and _GROUP_ID_RE.fullmatch(gid):
        return gid
    return SYSTEM_GROUP_ID

# Deterministic namespace UUIDs — stable across replays.
_NS_CAMPAIGN = uuid.UUID("a1b2c3d4-e5f6-7890-abcd-ef1234567890")
_NS_ROUND = uuid.UUID("b2c3d4e5-f6a7-8901-bcde-f01234567891")
_NS_MEASURED_BY = uuid.UUID("c3d4e5f6-a7b8-9012-cdef-012345678912")


class KgOptimizationCampaignProjector(BaseProjector):
    name = "kg_optimization_campaign"
    interested_event_types = (
        "optimization_round_proposed",
        "optimization_results_ingested",
    )

    def __init__(self, settings: ProjectorSettings) -> None:
        super().__init__(settings)
        self._neo4j = Neo4jClient.from_env()

    async def close(self) -> None:
        await self._neo4j.close()

    async def handle(
        self,
        *,
        event_id: str,
        event_type: str,
        source_table: str | None,
        source_row_id: str | None,
        payload: dict[str, Any],
    ) -> None:
        campaign_id = payload.get("campaign_id")
        round_id = payload.get("round_id") or source_row_id
        if not campaign_id or not round_id:
            log.warning(
                "event %s missing campaign_id or round_id in payload; skipping",
                event_id,
            )
            return

        if event_type == "optimization_round_proposed":
            await self._handle_proposed(campaign_id, round_id, payload)
        elif event_type == "optimization_results_ingested":
            await self._handle_results_ingested(campaign_id, round_id, payload)

    async def _load_campaign(self, campaign_id: str) -> dict[str, Any] | None:
        async with await psycopg.AsyncConnection.connect(
            self.settings.postgres_dsn
        ) as conn, conn.cursor() as cur:
            await cur.execute(
                "SELECT id::text, campaign_name, strategy, acquisition, status, "
                "       nce_project_id::text, created_at "
                "  FROM optimization_campaigns WHERE id = %s::uuid",
                (campaign_id,),
            )
            row = await cur.fetchone()
        if row is None:
            return None
        return {
            "id": row[0],
            "name": row[1],
            "strategy": row[2],
            "acquisition": row[3],
            "status": row[4],
            "nce_project_id": row[5],
            "created_at": row[6].isoformat() if hasattr(row[6], "isoformat") else str(row[6]),
        }

    async def _load_round(self, round_id: str) -> dict[str, Any] | None:
        async with await psycopg.AsyncConnection.connect(
            self.settings.postgres_dsn
        ) as conn, conn.cursor() as cur:
            await cur.execute(
                "SELECT id::text, campaign_id::text, round_index, proposed_at, "
                "       ingested_results_at, "
                "       COALESCE(jsonb_array_length(proposals), 0) AS n_proposals, "
                "       COALESCE(jsonb_array_length(measured_outcomes), 0) AS n_outcomes "
                "  FROM optimization_rounds WHERE id = %s::uuid",
                (round_id,),
            )
            row = await cur.fetchone()
        if row is None:
            return None
        return {
            "id": row[0],
            "campaign_id": row[1],
            "round_index": row[2],
            "proposed_at": row[3].isoformat() if hasattr(row[3], "isoformat") else str(row[3]),
            "results_at": (
                row[4].isoformat() if row[4] is not None and hasattr(row[4], "isoformat")
                else (str(row[4]) if row[4] is not None else None)
            ),
            "n_proposals": row[5],
            "n_outcomes": row[6],
        }

    def _campaign_fact_id(self, campaign_id: str) -> str:
        return str(uuid.uuid5(_NS_CAMPAIGN, campaign_id))

    def _round_fact_id(self, round_id: str) -> str:
        return str(uuid.uuid5(_NS_ROUND, round_id))

    def _edge_fact_id(self, campaign_id: str, round_id: str) -> str:
        return str(uuid.uuid5(_NS_MEASURED_BY, f"{campaign_id}|{round_id}"))

    async def _upsert_campaign_node(
        self, session: Any, campaign: dict[str, Any], group_id: str
    ) -> None:
        # status is re-stamped on every MATCH so the last round event reflects the
        # current campaign status.  NOTE: lifecycle transitions (pause/resume/complete)
        # do not emit ingestion_events today — status will lag until the next round
        # event fires. See BACKLOG [bo/campaign-status-events].
        await session.run(
            """
            MERGE (c:OptimizationCampaign {fact_id: $fact_id})
              ON CREATE SET c.campaign_id   = $campaign_id,
                            c.name          = $name,
                            c.strategy      = $strategy,
                            c.acquisition   = $acquisition,
                            c.status        = $status,
                            c.nce_project_id = $nce_project_id,
                            c.created_at    = $created_at,
                            c.group_id      = $group_id
              ON MATCH  SET c.status        = $status,
                            c.group_id      = $group_id
            """,
            fact_id=self._campaign_fact_id(campaign["id"]),
            campaign_id=campaign["id"],
            name=campaign["name"],
            strategy=campaign["strategy"],
            acquisition=campaign["acquisition"],
            status=campaign["status"],
            nce_project_id=campaign["nce_project_id"],
            created_at=campaign["created_at"],
            group_id=group_id,
        )

    async def _upsert_round_node(
        self, session: Any, round_data: dict[str, Any], group_id: str
    ) -> None:
        await session.run(
            """
            MERGE (r:OptimizationRound {fact_id: $fact_id})
              ON CREATE SET r.round_id      = $round_id,
                            r.campaign_id   = $campaign_id,
                            r.round_index   = $round_index,
                            r.n_proposals   = $n_proposals,
                            r.n_outcomes    = $n_outcomes,
                            r.proposed_at   = $proposed_at,
                            r.results_at    = $results_at,
                            r.group_id      = $group_id
              ON MATCH  SET r.n_proposals   = $n_proposals,
                            r.n_outcomes    = CASE
                              WHEN $n_outcomes > 0 THEN $n_outcomes
                              ELSE r.n_outcomes END,
                            r.results_at    = CASE
                              WHEN $results_at IS NOT NULL THEN $results_at
                              ELSE r.results_at END,
                            r.group_id      = $group_id
            """,
            fact_id=self._round_fact_id(round_data["id"]),
            round_id=round_data["id"],
            campaign_id=round_data["campaign_id"],
            round_index=round_data["round_index"],
            n_proposals=round_data["n_proposals"],
            n_outcomes=round_data["n_outcomes"],
            proposed_at=round_data["proposed_at"],
            results_at=round_data["results_at"],
            group_id=group_id,
        )

    async def _upsert_edge(
        self,
        session: Any,
        campaign: dict[str, Any],
        round_data: dict[str, Any],
        group_id: str,
    ) -> None:
        await session.run(
            """
            MATCH (c:OptimizationCampaign {fact_id: $c_fact_id})
            MATCH (r:OptimizationRound    {fact_id: $r_fact_id})
            MERGE (c)-[e:MEASURED_BY {fact_id: $edge_fact_id}]->(r)
              ON CREATE SET e.round_index = $round_index,
                            e.group_id   = $group_id
            """,
            c_fact_id=self._campaign_fact_id(campaign["id"]),
            r_fact_id=self._round_fact_id(round_data["id"]),
            edge_fact_id=self._edge_fact_id(campaign["id"], round_data["id"]),
            round_index=round_data["round_index"],
            group_id=group_id,
        )

    async def _handle_proposed(
        self, campaign_id: str, round_id: str, payload: dict[str, Any]
    ) -> None:
        campaign = await self._load_campaign(campaign_id)
        if campaign is None:
            log.warning("campaign %s not found; skipping round %s", campaign_id, round_id)
            return
        round_data = await self._load_round(round_id)
        if round_data is None:
            log.warning("round %s not found; skipping", round_id)
            return

        group_id = _safe_group_id(campaign.get("nce_project_id"))
        async with self._neo4j.session() as session:
            await self._upsert_campaign_node(session, campaign, group_id)
            await self._upsert_round_node(session, round_data, group_id)
            await self._upsert_edge(session, campaign, round_data, group_id)

        log.info(
            "kg_opt_campaign: upserted round %s (index=%d, n_proposals=%d) for campaign %s",
            round_id,
            round_data["round_index"],
            round_data["n_proposals"],
            campaign_id,
        )

    async def _handle_results_ingested(
        self, campaign_id: str, round_id: str, payload: dict[str, Any]
    ) -> None:
        round_data = await self._load_round(round_id)
        if round_data is None:
            log.warning("round %s not found on results_ingested; skipping", round_id)
            return
        campaign = await self._load_campaign(campaign_id)
        if campaign is None:
            log.warning("campaign %s not found on results_ingested; skipping", campaign_id)
            return

        group_id = _safe_group_id(campaign.get("nce_project_id"))
        async with self._neo4j.session() as session:
            await self._upsert_campaign_node(session, campaign, group_id)
            await self._upsert_round_node(session, round_data, group_id)
            await self._upsert_edge(session, campaign, round_data, group_id)

        log.info(
            "kg_opt_campaign: enriched round %s with n_outcomes=%d",
            round_id,
            round_data["n_outcomes"],
        )


def main() -> None:  # pragma: no cover — process entrypoint
    settings = ProjectorSettings()
    configure_logging(settings.projector_log_level, service="kg_optimization_campaign")
    proj = KgOptimizationCampaignProjector(settings)
    try:
        asyncio.run(proj.run())
    finally:
        asyncio.run(proj.close())


if __name__ == "__main__":
    main()
