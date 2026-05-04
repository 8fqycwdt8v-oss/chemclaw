"""Tranche 1 / C6 unit test: kg_experiments must thread the canonical
project UUID through to mcp-kg as `group_id` on every fact write.

The projector does several `write_fact` calls per experiment; we don't
care about the per-call shape here (that's `test_kg_experiments_determinism`),
only that *every* call carries the project UUID derived from
`bundle["project_id"]`.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from services.projectors.kg_experiments.main import KGExperimentsProjector, Settings


PROJECT_UUID = "11111111-2222-3333-4444-555555555555"


def _bundle() -> dict[str, Any]:
    return {
        "experiment_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "eln_entry_id": "ELN-42",
        "operator_entra_id": "alice@example.com",
        "yield_pct": 87.5,
        "scale_mg": 100.0,
        "outcome_status": "complete",
        "procedure_text": None,
        "observations": None,
        "step_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "step_index": 1,
        "step_name": "amide-coupling",
        "project_id": PROJECT_UUID,
        "project_internal_id": "NCE-007",
        "project_name": "Demo NCE",
        "therapeutic_area": "oncology",
        "phase": "lead-opt",
        "status": "active",
        "reactions": [],  # no reactions: first three write_fact calls are enough
    }


def _settings() -> Settings:
    # Pin every required Settings field explicitly so the test doesn't
    # depend on .env state on the runner.
    return Settings(
        postgres_dsn="postgresql://stub",
        mcp_kg_url="http://stub",
        mcp_rdkit_url="http://stub",
    )


@pytest.mark.asyncio
async def test_handle_threads_project_uuid_as_group_id() -> None:
    proj = KGExperimentsProjector(_settings())
    proj._kg = AsyncMock()  # noqa: SLF001 — replacing the network surface
    proj._kg.write_fact = AsyncMock(return_value={"fact_id": "x", "created": True})

    # Skip the network read for the bundle; feed a synthetic one.
    with patch.object(
        proj, "_load_experiment_bundle", AsyncMock(return_value=_bundle())
    ):
        await proj.handle(
            event_id="evt-1",
            event_type="experiment_imported",
            source_table="experiments",
            source_row_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            payload={},
        )

    assert proj._kg.write_fact.await_count >= 3, "expected at least 3 write_fact calls"
    for call in proj._kg.write_fact.await_args_list:
        kwargs = call.kwargs
        assert kwargs.get("group_id") == PROJECT_UUID, (
            f"write_fact called without expected group_id: {kwargs}"
        )
