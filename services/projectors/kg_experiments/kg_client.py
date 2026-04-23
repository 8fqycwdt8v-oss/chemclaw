"""Thin async client for mcp-kg REST endpoints.

Intentionally minimal — we only wrap what the KG projector needs. The full
typed contract lives in services.mcp_tools.mcp_kg.models; we re-serialise
at the network boundary rather than depend on it directly to keep projectors
loosely coupled to the KG service's internal types.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger("projector.kg_client")


class KGClient:
    def __init__(self, base_url: str, *, timeout_s: float = 15.0) -> None:
        self._client = httpx.AsyncClient(base_url=base_url, timeout=timeout_s)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def write_fact(
        self,
        *,
        subject_label: str,
        subject_id_property: str,
        subject_id_value: str,
        subject_properties: dict[str, Any] | None,
        object_label: str,
        object_id_property: str,
        object_id_value: str,
        object_properties: dict[str, Any] | None,
        predicate: str,
        edge_properties: dict[str, Any] | None,
        source_type: str,
        source_id: str,
        fact_id: str | None = None,
        confidence_tier: str = "multi_source_llm",
        confidence_score: float = 0.75,
    ) -> dict[str, Any]:
        payload = {
            "subject": {
                "label": subject_label,
                "id_property": subject_id_property,
                "id_value": subject_id_value,
            },
            "object": {
                "label": object_label,
                "id_property": object_id_property,
                "id_value": object_id_value,
            },
            "predicate": predicate,
            "subject_properties": subject_properties,
            "object_properties": object_properties,
            "edge_properties": edge_properties,
            "confidence_tier": confidence_tier,
            "confidence_score": confidence_score,
            "provenance": {
                "source_type": source_type,
                "source_id": source_id,
            },
        }
        if fact_id is not None:
            payload["fact_id"] = fact_id

        r = await self._client.post("/tools/write_fact", json=payload)
        r.raise_for_status()
        return r.json()
