"""Neo4j driver wrapper for mcp-kg.

Concerns handled here:
- Connection pool management (single driver per process; threadsafe)
- Serialising the provenance sub-object for Cypher (map → JSON string)
- Converting Python aware datetimes into Neo4j DateTime
- Parsing Neo4j records back into domain types
- Startup bootstrap: creates uniqueness constraint + relationship index
- Write idempotency via a single MERGE statement (no TOCTOU — see cypher.py)
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any
from uuid import UUID

from neo4j import AsyncDriver, AsyncGraphDatabase
from neo4j.time import DateTime as Neo4jDateTime

from services.mcp_tools.mcp_kg.cypher import (
    bootstrap_cyphers,
    build_invalidate_fact_cypher,
    build_query_at_time_cypher,
    build_write_fact_cypher,
)
from services.mcp_tools.mcp_kg.models import (
    ConfidenceTier,
    EntityRef,
    InvalidateFactRequest,
    InvalidateFactResponse,
    Provenance,
    QueriedFact,
    QueryAtTimeRequest,
    QueryAtTimeResponse,
    WriteFactRequest,
    WriteFactResponse,
    new_fact_id,
    utcnow,
)

log = logging.getLogger("mcp-kg.driver")


def _n4j_to_py(value: Any) -> Any:
    """Convert a Neo4j-typed value (DateTime etc.) to JSON-serialisable Python."""
    if isinstance(value, Neo4jDateTime):
        return value.to_native()
    if isinstance(value, dict):
        return {k: _n4j_to_py(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_n4j_to_py(v) for v in value]
    return value


def _load_provenance(raw: str | dict[str, Any] | None) -> Provenance:
    if isinstance(raw, str):
        raw = json.loads(raw)
    if raw is None:
        raise ValueError("fact missing provenance")
    return Provenance.model_validate(raw)


def _derive_id_property_from_node(props: dict[str, Any]) -> tuple[str, str]:
    """Heuristic: find the node's primary identifier property.

    We prefer, in order: inchikey, internal_id, uuid, id, then any scalar.
    This matches the conventions in the plan's ontology.
    """
    for candidate in ("inchikey", "internal_id", "uuid", "id"):
        if candidate in props and isinstance(props[candidate], str):
            return candidate, props[candidate]
    for k, v in props.items():
        if isinstance(v, str):
            return k, v
    raise ValueError("cannot derive id property from node")


class KGDriver:
    """Async wrapper around the Neo4j driver."""

    def __init__(
        self,
        uri: str,
        user: str,
        password: str,
        *,
        max_connection_pool_size: int = 20,
    ) -> None:
        self._driver: AsyncDriver = AsyncGraphDatabase.driver(
            uri,
            auth=(user, password),
            max_connection_pool_size=max_connection_pool_size,
            connection_acquisition_timeout=15.0,
            connection_timeout=15.0,
        )

    async def verify(self) -> None:
        """Raise if the driver can't reach Neo4j (used by /readyz)."""
        await self._driver.verify_connectivity()

    async def bootstrap(self) -> None:
        """Apply the one-time uniqueness constraint + indexes. Idempotent."""
        async with self._driver.session() as session:
            for stmt in bootstrap_cyphers():
                try:
                    await session.run(stmt)
                except Exception as exc:  # noqa: BLE001 — diagnostic only
                    log.warning("bootstrap stmt failed (continuing): %s — %s", stmt, exc)

    async def close(self) -> None:
        await self._driver.close()

    # ----- WRITE ---------------------------------------------------------
    async def write_fact(self, req: WriteFactRequest) -> WriteFactResponse:
        """Idempotent, race-safe fact write.

        The Cypher uses MERGE on (fact_id) so concurrent calls with the same
        fact_id produce exactly one edge; the RETURN value's `created` flag
        tells us whether this call was the creator or a duplicate.
        """
        now = utcnow()
        fact_id = req.fact_id or new_fact_id()
        t_valid_from = req.t_valid_from or now

        query, params = build_write_fact_cypher(req)
        params.update(
            {
                "fact_id": str(fact_id),
                "t_valid_from": t_valid_from,
                "recorded_at": now,
                "provenance": req.provenance.model_dump_json(),
            }
        )

        async with self._driver.session() as session:
            res = await session.run(query, params)
            row = await res.single()
            if row is None:
                raise RuntimeError("write_fact: Neo4j returned no row")
            return WriteFactResponse(
                fact_id=fact_id,
                created=bool(row["created"]),
                t_valid_from=_n4j_to_py(row["t_valid_from"]),
                recorded_at=_n4j_to_py(row["recorded_at"]),
            )

    # ----- INVALIDATE ----------------------------------------------------
    async def invalidate_fact(self, req: InvalidateFactRequest) -> InvalidateFactResponse:
        now = utcnow()
        t_valid_to = req.t_valid_to or now
        async with self._driver.session() as session:
            res = await session.run(
                build_invalidate_fact_cypher(),
                {
                    "fact_id": str(req.fact_id),
                    "t_valid_to": t_valid_to,
                    "invalidated_at": now,
                    "reason": req.reason,
                    "provenance": req.invalidated_by_provenance.model_dump_json(),
                    "new_confidence_tier": req.new_confidence_tier.value,
                },
            )
            row = await res.single()
            if row is None:
                raise LookupError(f"fact_id {req.fact_id} not found")
            return InvalidateFactResponse(
                fact_id=req.fact_id,
                invalidated_at=_n4j_to_py(row["invalidated_at"]),
                was_already_invalid=bool(row["was_already_invalid"]),
            )

    # ----- QUERY ---------------------------------------------------------
    async def query_at_time(self, req: QueryAtTimeRequest) -> QueryAtTimeResponse:
        query, params = build_query_at_time_cypher(req)
        async with self._driver.session() as session:
            res = await session.run(query, params)
            records = [r async for r in res]

        facts: list[QueriedFact] = []
        for r in records:
            edge = _n4j_to_py(dict(r["edge_properties"]))
            s_labels: list[str] = r["s_labels"]
            o_labels: list[str] = r["o_labels"]
            s_props = _n4j_to_py(dict(r["s_props"]))
            o_props = _n4j_to_py(dict(r["o_props"]))
            n_is_subject = bool(r["n_is_subject"])
            subj_label = (
                (s_labels[0] if s_labels else req.entity.label)
                if n_is_subject
                else (o_labels[0] if o_labels else "Unknown")
            )
            obj_label = (
                (o_labels[0] if o_labels else "Unknown")
                if n_is_subject
                else (s_labels[0] if s_labels else req.entity.label)
            )
            subj_props = s_props if n_is_subject else o_props
            obj_props = o_props if n_is_subject else s_props

            subj_key, subj_val = _derive_id_property_from_node(subj_props)
            obj_key, obj_val = _derive_id_property_from_node(obj_props)

            facts.append(
                QueriedFact(
                    fact_id=UUID(edge["fact_id"]),
                    subject=EntityRef(label=subj_label, id_property=subj_key, id_value=subj_val),
                    predicate=str(r["predicate"]),
                    object=EntityRef(label=obj_label, id_property=obj_key, id_value=obj_val),
                    edge_properties={
                        k: v
                        for k, v in edge.items()
                        if k
                        not in {
                            "fact_id",
                            "t_valid_from",
                            "t_valid_to",
                            "recorded_at",
                            "invalidated_at",
                            "confidence_tier",
                            "confidence_score",
                            "provenance",
                            "invalidation_reason",
                            "invalidation_provenance",
                        }
                    },
                    confidence_tier=ConfidenceTier(edge["confidence_tier"]),
                    confidence_score=float(edge["confidence_score"]),
                    t_valid_from=edge["t_valid_from"],
                    t_valid_to=edge.get("t_valid_to"),
                    recorded_at=edge["recorded_at"],
                    provenance=_load_provenance(edge.get("provenance")),
                )
            )
        return QueryAtTimeResponse(facts=facts)
