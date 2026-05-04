"""Tranche 1 / C6: kg_client.write_fact must include `group_id` in the
HTTP payload only when the caller passes it; without it, the field is
omitted so mcp-kg's server-side default ('__system__') applies.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from services.projectors.kg_experiments.kg_client import KGClient


def _kwargs() -> dict[str, Any]:
    return {
        "subject_label": "Compound",
        "subject_id_property": "inchikey",
        "subject_id_value": "INCHI-1",
        "subject_properties": None,
        "object_label": "Reaction",
        "object_id_property": "uuid",
        "object_id_value": "rxn-1",
        "object_properties": None,
        "predicate": "IS_REAGENT_IN",
        "edge_properties": None,
        "source_type": "ELN",
        "source_id": "ELN-42",
    }


class _FakeResponse:
    def raise_for_status(self) -> None:  # pragma: no cover — trivial
        return None

    def json(self) -> dict[str, Any]:
        return {"fact_id": "x", "created": True, "t_valid_from": "2026-05-04T00:00:00+00:00", "recorded_at": "2026-05-04T00:00:00+00:00"}


@pytest.mark.asyncio
async def test_write_fact_includes_group_id_when_provided() -> None:
    client = KGClient("http://stub")
    posted: dict[str, Any] = {}

    async def _capture(url: str, *, json: dict[str, Any]) -> _FakeResponse:
        posted["url"] = url
        posted["json"] = json
        return _FakeResponse()

    with patch.object(client._client, "post", AsyncMock(side_effect=_capture)):  # noqa: SLF001
        await client.write_fact(**_kwargs(), group_id="proj-NCE-007")

    assert posted["url"] == "/tools/write_fact"
    assert posted["json"]["group_id"] == "proj-NCE-007"
    await client.aclose()


@pytest.mark.asyncio
async def test_write_fact_omits_group_id_when_unset() -> None:
    """Caller didn't supply tenant context; let mcp-kg apply its default."""
    client = KGClient("http://stub")
    posted: dict[str, Any] = {}

    async def _capture(url: str, *, json: dict[str, Any]) -> _FakeResponse:
        posted["json"] = json
        return _FakeResponse()

    with patch.object(client._client, "post", AsyncMock(side_effect=_capture)):  # noqa: SLF001
        await client.write_fact(**_kwargs())

    assert "group_id" not in posted["json"]
    await client.aclose()
