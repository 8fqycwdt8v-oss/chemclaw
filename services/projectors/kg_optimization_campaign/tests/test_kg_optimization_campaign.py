"""Unit tests for KgOptimizationCampaignProjector.

Mocks both Postgres (psycopg) and Neo4j so the suite runs without
infrastructure. Pins:
  1. fact_id determinism — UUIDv5 from namespace + domain key.
  2. MERGE Cypher emitted for both event types.
  3. Missing-row skip paths (campaign/round not found).
  4. results_ingested path re-upserts campaign node + enriches round.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.projectors.kg_optimization_campaign.main import (
    KgOptimizationCampaignProjector,
    _NS_CAMPAIGN,
    _NS_ROUND,
    _NS_MEASURED_BY,
)
from services.projectors.common.base import ProjectorSettings


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

CAMPAIGN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
ROUND_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
NCE_PROJECT_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc"


def _expected_campaign_fact_id() -> str:
    return str(uuid.uuid5(_NS_CAMPAIGN, CAMPAIGN_ID))


def _expected_round_fact_id() -> str:
    return str(uuid.uuid5(_NS_ROUND, ROUND_ID))


def _expected_edge_fact_id() -> str:
    return str(uuid.uuid5(_NS_MEASURED_BY, f"{CAMPAIGN_ID}|{ROUND_ID}"))


class _FakeNeo4jSession:
    def __init__(self) -> None:
        self.runs: list[tuple[str, dict[str, Any]]] = []

    async def __aenter__(self) -> "_FakeNeo4jSession":
        return self

    async def __aexit__(self, *_: Any) -> None:
        pass

    async def run(self, query: str, **params: Any) -> None:
        self.runs.append((query, params))


def _build_pg_connection(*rows: tuple | None) -> Any:
    """Returns a mock psycopg connection whose fetchone() yields rows in order."""
    remaining = list(rows)

    async def _fetchone() -> tuple | None:
        return remaining.pop(0) if remaining else None

    cur = MagicMock()
    cur.execute = AsyncMock()
    cur.fetchone = AsyncMock(side_effect=_fetchone)
    cur.__aenter__ = AsyncMock(return_value=cur)
    cur.__aexit__ = AsyncMock(return_value=None)

    conn = MagicMock()
    conn.cursor = MagicMock(return_value=cur)
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=None)

    return conn


def _campaign_row() -> tuple:
    return (
        CAMPAIGN_ID,
        "Test Campaign",
        "bayesian",
        "qEI",
        "active",
        NCE_PROJECT_ID,
        datetime(2026, 1, 1, tzinfo=timezone.utc),
    )


def _round_row(n_outcomes: int = 0, results_at: datetime | None = None) -> tuple:
    return (
        ROUND_ID,
        CAMPAIGN_ID,
        0,                                               # round_index
        datetime(2026, 1, 2, tzinfo=timezone.utc),      # proposed_at
        results_at,
        3,                                               # n_proposals
        n_outcomes,
    )


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def settings() -> ProjectorSettings:
    return ProjectorSettings(
        postgres_dsn="postgresql://chemclaw_service:x@localhost:5432/chemclaw",
        projector_log_level="WARNING",
    )


@pytest.fixture()
def neo4j_session() -> _FakeNeo4jSession:
    return _FakeNeo4jSession()


@pytest.fixture()
def projector(settings: ProjectorSettings, neo4j_session: _FakeNeo4jSession) -> KgOptimizationCampaignProjector:
    with patch(
        "services.projectors.kg_optimization_campaign.main.Neo4jClient.from_env"
    ) as mock_neo4j_cls:
        mock_neo4j = MagicMock()
        mock_neo4j.session = MagicMock(return_value=neo4j_session)
        mock_neo4j_cls.return_value = mock_neo4j
        proj = KgOptimizationCampaignProjector(settings)
    return proj


# ---------------------------------------------------------------------------
# tests
# ---------------------------------------------------------------------------

class TestFactIds:
    def test_campaign_fact_id_is_deterministic(self, projector: KgOptimizationCampaignProjector) -> None:
        assert projector._campaign_fact_id(CAMPAIGN_ID) == _expected_campaign_fact_id()

    def test_round_fact_id_is_deterministic(self, projector: KgOptimizationCampaignProjector) -> None:
        assert projector._round_fact_id(ROUND_ID) == _expected_round_fact_id()

    def test_edge_fact_id_is_deterministic(self, projector: KgOptimizationCampaignProjector) -> None:
        assert projector._edge_fact_id(CAMPAIGN_ID, ROUND_ID) == _expected_edge_fact_id()

    def test_different_campaigns_produce_different_fact_ids(self, projector: KgOptimizationCampaignProjector) -> None:
        a = projector._campaign_fact_id("aaaaaaaa-aaaa-aaaa-aaaa-000000000001")
        b = projector._campaign_fact_id("aaaaaaaa-aaaa-aaaa-aaaa-000000000002")
        assert a != b


class TestHandleProposed:
    @pytest.mark.asyncio
    async def test_emits_three_cypher_statements(
        self,
        projector: KgOptimizationCampaignProjector,
        neo4j_session: _FakeNeo4jSession,
    ) -> None:
        conn = _build_pg_connection(_campaign_row(), _round_row())
        with patch("psycopg.AsyncConnection.connect", return_value=conn):
            await projector.handle(
                event_id="ev-1",
                event_type="optimization_round_proposed",
                source_table="optimization_rounds",
                source_row_id=ROUND_ID,
                payload={"campaign_id": CAMPAIGN_ID, "round_id": ROUND_ID},
            )

        # MERGE campaign, MERGE round, MERGE edge
        assert len(neo4j_session.runs) == 3

    @pytest.mark.asyncio
    async def test_campaign_node_params(
        self,
        projector: KgOptimizationCampaignProjector,
        neo4j_session: _FakeNeo4jSession,
    ) -> None:
        conn = _build_pg_connection(_campaign_row(), _round_row())
        with patch("psycopg.AsyncConnection.connect", return_value=conn):
            await projector.handle(
                event_id="ev-2",
                event_type="optimization_round_proposed",
                source_table="optimization_rounds",
                source_row_id=ROUND_ID,
                payload={"campaign_id": CAMPAIGN_ID, "round_id": ROUND_ID},
            )

        _cypher, params = neo4j_session.runs[0]
        assert params["fact_id"] == _expected_campaign_fact_id()
        assert params["campaign_id"] == CAMPAIGN_ID
        assert params["name"] == "Test Campaign"
        assert params["status"] == "active"
        assert params["group_id"] == NCE_PROJECT_ID

    @pytest.mark.asyncio
    async def test_round_node_params(
        self,
        projector: KgOptimizationCampaignProjector,
        neo4j_session: _FakeNeo4jSession,
    ) -> None:
        conn = _build_pg_connection(_campaign_row(), _round_row())
        with patch("psycopg.AsyncConnection.connect", return_value=conn):
            await projector.handle(
                event_id="ev-3",
                event_type="optimization_round_proposed",
                source_table="optimization_rounds",
                source_row_id=ROUND_ID,
                payload={"campaign_id": CAMPAIGN_ID, "round_id": ROUND_ID},
            )

        _cypher, params = neo4j_session.runs[1]
        assert params["fact_id"] == _expected_round_fact_id()
        assert params["round_id"] == ROUND_ID
        assert params["n_proposals"] == 3
        assert params["n_outcomes"] == 0
        assert params["results_at"] is None

    @pytest.mark.asyncio
    async def test_edge_params(
        self,
        projector: KgOptimizationCampaignProjector,
        neo4j_session: _FakeNeo4jSession,
    ) -> None:
        conn = _build_pg_connection(_campaign_row(), _round_row())
        with patch("psycopg.AsyncConnection.connect", return_value=conn):
            await projector.handle(
                event_id="ev-4",
                event_type="optimization_round_proposed",
                source_table="optimization_rounds",
                source_row_id=ROUND_ID,
                payload={"campaign_id": CAMPAIGN_ID, "round_id": ROUND_ID},
            )

        _cypher, params = neo4j_session.runs[2]
        assert params["edge_fact_id"] == _expected_edge_fact_id()
        assert params["c_fact_id"] == _expected_campaign_fact_id()
        assert params["r_fact_id"] == _expected_round_fact_id()
        assert params["group_id"] == NCE_PROJECT_ID

    @pytest.mark.asyncio
    async def test_skips_when_campaign_not_found(
        self,
        projector: KgOptimizationCampaignProjector,
        neo4j_session: _FakeNeo4jSession,
    ) -> None:
        conn = _build_pg_connection(None, _round_row())
        with patch("psycopg.AsyncConnection.connect", return_value=conn):
            await projector.handle(
                event_id="ev-5",
                event_type="optimization_round_proposed",
                source_table="optimization_rounds",
                source_row_id=ROUND_ID,
                payload={"campaign_id": CAMPAIGN_ID, "round_id": ROUND_ID},
            )

        assert len(neo4j_session.runs) == 0

    @pytest.mark.asyncio
    async def test_skips_when_round_not_found(
        self,
        projector: KgOptimizationCampaignProjector,
        neo4j_session: _FakeNeo4jSession,
    ) -> None:
        conn = _build_pg_connection(_campaign_row(), None)
        with patch("psycopg.AsyncConnection.connect", return_value=conn):
            await projector.handle(
                event_id="ev-6",
                event_type="optimization_round_proposed",
                source_table="optimization_rounds",
                source_row_id=ROUND_ID,
                payload={"campaign_id": CAMPAIGN_ID, "round_id": ROUND_ID},
            )

        assert len(neo4j_session.runs) == 0

    @pytest.mark.asyncio
    async def test_skips_when_missing_ids_in_payload(
        self,
        projector: KgOptimizationCampaignProjector,
        neo4j_session: _FakeNeo4jSession,
    ) -> None:
        with patch("psycopg.AsyncConnection.connect") as mock_conn:
            await projector.handle(
                event_id="ev-7",
                event_type="optimization_round_proposed",
                source_table=None,
                source_row_id=None,
                payload={},
            )
            mock_conn.assert_not_called()

        assert len(neo4j_session.runs) == 0


class TestHandleResultsIngested:
    @pytest.mark.asyncio
    async def test_enriches_round_with_outcomes(
        self,
        projector: KgOptimizationCampaignProjector,
        neo4j_session: _FakeNeo4jSession,
    ) -> None:
        results_at = datetime(2026, 1, 3, tzinfo=timezone.utc)
        # results_ingested loads round first, then campaign
        conn = _build_pg_connection(_round_row(n_outcomes=3, results_at=results_at), _campaign_row())
        with patch("psycopg.AsyncConnection.connect", return_value=conn):
            await projector.handle(
                event_id="ev-8",
                event_type="optimization_results_ingested",
                source_table="optimization_rounds",
                source_row_id=ROUND_ID,
                payload={"campaign_id": CAMPAIGN_ID, "round_id": ROUND_ID},
            )

        assert len(neo4j_session.runs) == 3
        _cypher, params = neo4j_session.runs[1]
        assert params["n_outcomes"] == 3
        assert params["results_at"] == results_at.isoformat()

    @pytest.mark.asyncio
    async def test_results_ingested_skips_when_round_missing(
        self,
        projector: KgOptimizationCampaignProjector,
        neo4j_session: _FakeNeo4jSession,
    ) -> None:
        # results_ingested loads round first; None → early return before loading campaign
        conn = _build_pg_connection(None, _campaign_row())
        with patch("psycopg.AsyncConnection.connect", return_value=conn):
            await projector.handle(
                event_id="ev-9",
                event_type="optimization_results_ingested",
                source_table="optimization_rounds",
                source_row_id=ROUND_ID,
                payload={"campaign_id": CAMPAIGN_ID, "round_id": ROUND_ID},
            )

        assert len(neo4j_session.runs) == 0

    @pytest.mark.asyncio
    async def test_round_id_falls_back_to_source_row_id(
        self,
        projector: KgOptimizationCampaignProjector,
        neo4j_session: _FakeNeo4jSession,
    ) -> None:
        conn = _build_pg_connection(_campaign_row(), _round_row())
        with patch("psycopg.AsyncConnection.connect", return_value=conn):
            await projector.handle(
                event_id="ev-10",
                event_type="optimization_round_proposed",
                source_table="optimization_rounds",
                source_row_id=ROUND_ID,
                payload={"campaign_id": CAMPAIGN_ID},  # round_id absent — falls back to source_row_id
            )

        assert len(neo4j_session.runs) == 3

    @pytest.mark.asyncio
    async def test_unknown_event_type_is_ignored(
        self,
        projector: KgOptimizationCampaignProjector,
        neo4j_session: _FakeNeo4jSession,
    ) -> None:
        with patch("psycopg.AsyncConnection.connect") as mock_conn:
            await projector.handle(
                event_id="ev-11",
                event_type="some_other_event",
                source_table=None,
                source_row_id=ROUND_ID,
                payload={"campaign_id": CAMPAIGN_ID, "round_id": ROUND_ID},
            )
            mock_conn.assert_not_called()
