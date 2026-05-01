"""Handler-level tests for the conditions_normalizer projector.

Mocks the DB connection at the AsyncConnection.connect boundary.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from unittest import mock

import pytest


def _make_settings():
    from services.projectors.conditions_normalizer.main import Settings
    return Settings(
        _env_file=None,
        postgres_host="localhost",
        postgres_db="x",
        postgres_user="x",
        postgres_password="x",
        mcp_rdkit_url="http://test",
        litellm_base_url="http://test",
        litellm_api_key="k",
        agent_model_compactor="m",
        conditions_normalizer_llm_fallback=False,  # disable LLM in tests
    )


def _patch_work_conn(proj, *, fetched_rows):
    """Replace proj._open_work_conn with a context manager yielding a mock conn.

    Returns the cursor mock so the test can inspect `cursor.execute` calls.
    """
    cursor = mock.MagicMock()
    cursor.execute = mock.AsyncMock()
    cursor.fetchall = mock.AsyncMock(return_value=fetched_rows)
    cursor.__aenter__ = mock.AsyncMock(return_value=cursor)
    cursor.__aexit__ = mock.AsyncMock(return_value=None)

    conn = mock.MagicMock()
    conn.cursor = mock.MagicMock(return_value=cursor)
    conn.commit = mock.AsyncMock()

    @asynccontextmanager
    async def fake_open():
        yield conn

    proj._open_work_conn = fake_open  # type: ignore[method-assign]
    return cursor


@pytest.mark.asyncio
async def test_handle_writes_update_for_each_reaction():
    """Two reactions in the experiment → two UPDATE statements."""
    from services.projectors.conditions_normalizer.main import ConditionsNormalizer

    proj = ConditionsNormalizer(_make_settings())
    fetched_rows = [
        {
            "reaction_id": "rxn-a",
            "rxn_smiles": "CC>>CC",
            "procedure_text": "Stirred in DCM at 80 °C for 16 h.",
            "tabular_data": {"solvent": "DCM"},
            "mock_eln_fields": {},
        },
        {
            "reaction_id": "rxn-b",
            "rxn_smiles": "CO>>CO",
            "procedure_text": "Refluxed in EtOH for 30 minutes.",
            "tabular_data": {},
            "mock_eln_fields": {},
        },
    ]
    cursor = _patch_work_conn(proj, fetched_rows=fetched_rows)

    await proj.handle(
        event_id="evt-1",
        event_type="experiment_imported",
        source_table="experiments",
        source_row_id="exp-1",
        payload={"experiment_id": "exp-1"},
    )

    update_calls = [
        c for c in cursor.execute.await_args_list
        if "UPDATE reactions" in (c.args[0] if c.args else "")
    ]
    assert len(update_calls) == 2


@pytest.mark.asyncio
async def test_handle_skips_event_with_no_reactions():
    """An experiment with no reactions emits no UPDATE."""
    from services.projectors.conditions_normalizer.main import ConditionsNormalizer

    proj = ConditionsNormalizer(_make_settings())
    cursor = _patch_work_conn(proj, fetched_rows=[])

    await proj.handle(
        event_id="evt-2",
        event_type="experiment_imported",
        source_table="experiments",
        source_row_id="exp-noreact",
        payload={"experiment_id": "exp-noreact"},
    )

    update_calls = [
        c for c in cursor.execute.await_args_list
        if "UPDATE reactions" in (c.args[0] if c.args else "")
    ]
    assert update_calls == []


@pytest.mark.asyncio
async def test_handle_unrelated_event_type_is_noop():
    """Events with mismatched event_type don't issue any DB calls."""
    from services.projectors.conditions_normalizer.main import ConditionsNormalizer

    proj = ConditionsNormalizer(_make_settings())
    open_mock = mock.MagicMock()
    proj._open_work_conn = open_mock  # type: ignore[method-assign]

    await proj.handle(
        event_id="evt-3",
        event_type="some_other_event",
        source_table=None,
        source_row_id=None,
        payload={},
    )

    open_mock.assert_not_called()
