"""kg_source_cache — project source_fact_observed events into Neo4j.

On `source_fact_observed`, writes a :Fact node with temporal provenance:
  - source_system_id: which ELN/LIMS/instrument system the fact came from
  - source_system_timestamp: the timestamp in the source system
  - fetched_at: when the agent fetched this fact
  - valid_until: TTL for cache invalidation (default now + 7 days)

The projector also checks for stale facts and emits a warning log. The agent
decides whether to re-fetch — no automatic invalidation occurs here.

Fact IDs are deterministic (UUIDv5) so replay is idempotent.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row
from pydantic_settings import SettingsConfigDict

from services.projectors.common.base import BaseProjector, ProjectorSettings
from services.projectors.kg_experiments.kg_client import KGClient

log = logging.getLogger("projector.kg_source_cache")

# Stable namespace for deterministic fact IDs.
_FACT_ID_NAMESPACE = uuid.UUID("cafecafe-cafe-cafe-cafe-cafecafecafe")

# Default cache TTL.
_DEFAULT_TTL_DAYS = 7


def _deterministic_fact_id(*parts: str) -> str:
    key = "|".join(parts)
    return str(uuid.uuid5(_FACT_ID_NAMESPACE, key))


class Settings(ProjectorSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    mcp_kg_url: str = "http://localhost:8003"
    source_cache_ttl_days: int = _DEFAULT_TTL_DAYS


class KGSourceCacheProjector(BaseProjector):
    name = "kg_source_cache"
    interested_event_types = ("source_fact_observed",)

    def __init__(self, settings: Settings) -> None:
        super().__init__(settings)
        self._s: Settings = settings
        self._kg = KGClient(settings.mcp_kg_url)

    async def aclose(self) -> None:
        await self._kg.aclose()

    # -----------------------------------------------------------------------
    # Handler
    # -----------------------------------------------------------------------
    async def handle(
        self,
        *,
        event_id: str,
        event_type: str,
        source_table: str | None,
        source_row_id: str | None,
        payload: dict[str, Any],
    ) -> None:
        """Project a source_fact_observed event into the KG as a :Fact node.

        Expected payload keys:
          source_system_id: str           — e.g. "benchling", "starlims", "waters"
          source_system_timestamp: str    — ISO-8601 from the source system
          fetched_at: str                 — ISO-8601 when the agent fetched this
          valid_until: str | None         — ISO-8601 TTL; default now + 7 days
          predicate: str                  — e.g. "HAS_PURITY", "HAS_YIELD"
          subject_id: str                 — subject node identifier
          object_value: str | float | int — scalar value (becomes a literal node)
        """
        if event_type != "source_fact_observed":
            return

        source_system_id: str = payload.get("source_system_id", "unknown")
        predicate: str = payload.get("predicate", "HAS_FACT")
        subject_id: str = str(payload.get("subject_id", "unknown"))
        object_value: Any = payload.get("object_value", "")
        source_system_timestamp: str = payload.get("source_system_timestamp", "")
        fetched_at: str = payload.get("fetched_at", datetime.now(timezone.utc).isoformat())

        if payload.get("valid_until"):
            valid_until: str = payload["valid_until"]
        else:
            valid_until = (
                datetime.now(timezone.utc) + timedelta(days=self._s.source_cache_ttl_days)
            ).isoformat()

        # Check if the fact is already stale — log but still write it so the
        # agent can see the provenance.
        try:
            vu_dt = datetime.fromisoformat(valid_until.replace("Z", "+00:00"))
            if vu_dt < datetime.now(timezone.utc):
                log.warning(
                    "source fact already stale: source_system_id=%s predicate=%s subject_id=%s valid_until=%s",
                    source_system_id,
                    predicate,
                    subject_id,
                    valid_until,
                )
        except ValueError:
            log.warning("invalid valid_until timestamp: %s", valid_until)

        fact_id = _deterministic_fact_id(
            event_id, source_system_id, predicate, subject_id, str(object_value)
        )

        object_str = str(object_value)

        edge_props = {
            "source_system_id": source_system_id,
            "source_system_timestamp": source_system_timestamp,
            "fetched_at": fetched_at,
            "valid_until": valid_until,
        }

        await self._kg.write_fact(
            subject_label="SourceEntity",
            subject_id_property="source_entity_id",
            subject_id_value=f"{source_system_id}:{subject_id}",
            subject_properties={
                "source_system_id": source_system_id,
                "external_id": subject_id,
            },
            object_label="LiteralFact",
            object_id_property="literal_id",
            object_id_value=f"{predicate}:{object_str}",
            object_properties={
                "value": object_str,
                "valid_until": valid_until,
            },
            predicate=predicate,
            edge_properties=edge_props,
            source_type="source_system",
            source_id=f"{source_system_id}:{subject_id}",
            fact_id=fact_id,
            confidence_tier="single_source_llm",
            confidence_score=0.80,
        )

        log.info(
            "projected source fact: fact_id=%s source=%s predicate=%s subject=%s",
            fact_id,
            source_system_id,
            predicate,
            subject_id,
        )


if __name__ == "__main__":
    settings = Settings()
    projector = KGSourceCacheProjector(settings)
    asyncio.run(projector.run())
