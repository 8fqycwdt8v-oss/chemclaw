"""Unit tests for the test_planner projector."""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.projectors.test_planner.main import (
    TestPlanner,
    TestPlannerSettings,
    _ALLOWED_CAMPAIGN_KINDS,
    _ALLOWED_STEP_KINDS,
    _call_llm,
    _validate_plan,
)
from services.projectors.common.base import ProjectorSettings


def _settings() -> tuple[ProjectorSettings, TestPlannerSettings]:
    base = ProjectorSettings(
        postgres_host="localhost", postgres_port=5432,
        postgres_db="test", postgres_user="test", postgres_password="test",
    )
    planner = TestPlannerSettings(
        postgres_host="localhost", postgres_port=5432,
        postgres_db="test", postgres_user="test", postgres_password="test",
        litellm_base_url="http://litellm:4000",
        litellm_api_key="test",
    )
    return base, planner


def _proj() -> TestPlanner:
    return TestPlanner(*_settings())


def _good_plan() -> dict[str, Any]:
    return {
        "campaign_name": "Discriminate pi-stacking hypothesis",
        "campaign_kind": "single_experiment",
        "goal": {"discriminating_condition": "measure yield with aromatic vs aliphatic"},
        "steps": [
            {"kind": "condition_design", "inputs": {"smiles": "c1ccccc1"}, "notes": "Design conditions"},
            {"kind": "forward_prediction", "inputs": {"smiles": "c1ccccc1"}, "notes": "Predict yield"},
            {"kind": "summary", "inputs": {}, "notes": "Compare predicted vs measured"},
        ],
    }


# ---------------------------------------------------------------------------
# _validate_plan
# ---------------------------------------------------------------------------


def test_validate_plan_accepts_good():
    assert _validate_plan(_good_plan()) is True


def test_validate_plan_rejects_missing_name():
    p = _good_plan()
    p["campaign_name"] = None
    assert _validate_plan(p) is False


def test_validate_plan_rejects_invalid_kind():
    p = _good_plan()
    p["campaign_kind"] = "bad_kind"
    assert _validate_plan(p) is False


def test_validate_plan_rejects_empty_steps():
    p = _good_plan()
    p["steps"] = []
    assert _validate_plan(p) is False


def test_validate_plan_rejects_invalid_step_kind():
    p = _good_plan()
    p["steps"][0]["kind"] = "not_a_valid_kind"
    assert _validate_plan(p) is False


def test_validate_plan_rejects_non_dict_step():
    p = _good_plan()
    p["steps"] = ["bad"]
    assert _validate_plan(p) is False


def test_validate_plan_null_plan():
    assert _validate_plan({"campaign_name": None, "campaign_kind": None, "goal": {}, "steps": []}) is False


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


def test_allowed_campaign_kinds_is_subset_of_synthesis_campaigns():
    # Must all be valid synthesis_campaigns.kind values
    known_kinds = {"single_experiment", "library_synthesis", "screening", "bo_campaign", "bo_or_die"}
    assert _ALLOWED_CAMPAIGN_KINDS <= known_kinds


def test_allowed_step_kinds_nonempty():
    assert len(_ALLOWED_STEP_KINDS) >= 5


# ---------------------------------------------------------------------------
# _call_llm
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_call_llm_returns_dict():
    plan = _good_plan()
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"choices": [{"message": {"content": json.dumps(plan)}}]}
    client = AsyncMock()
    client.post = AsyncMock(return_value=mock_resp)
    result = await _call_llm(client, _settings()[1], "sys", "usr")
    assert result == plan


@pytest.mark.asyncio
async def test_call_llm_returns_none_on_error():
    mock_resp = MagicMock()
    mock_resp.status_code = 500
    mock_resp.text = "error"
    client = AsyncMock()
    client.post = AsyncMock(return_value=mock_resp)
    result = await _call_llm(client, _settings()[1], "sys", "usr")
    assert result is None


@pytest.mark.asyncio
async def test_call_llm_returns_none_on_non_json():
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"choices": [{"message": {"content": "not json"}}]}
    client = AsyncMock()
    client.post = AsyncMock(return_value=mock_resp)
    result = await _call_llm(client, _settings()[1], "sys", "usr")
    assert result is None


@pytest.mark.asyncio
async def test_call_llm_returns_none_on_list():
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"choices": [{"message": {"content": "[{}, {}]"}}]}
    client = AsyncMock()
    client.post = AsyncMock(return_value=mock_resp)
    result = await _call_llm(client, _settings()[1], "sys", "usr")
    assert result is None


# ---------------------------------------------------------------------------
# handle() — missing fact_id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_skips_when_no_fact_id():
    proj = _proj()
    with patch("services.projectors.test_planner.main._call_llm") as mock_llm:
        with patch("psycopg.AsyncConnection.connect", new_callable=AsyncMock) as mc:
            mc.return_value.__aenter__ = AsyncMock(return_value=AsyncMock())
            mc.return_value.__aexit__ = AsyncMock(return_value=None)
            await proj.handle(
                event_id="e1",
                event_type="hypothesis_proposed",
                source_table=None,
                source_row_id=None,
                payload={},
            )
            mock_llm.assert_not_called()


# ---------------------------------------------------------------------------
# _plan_test — budget gate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_plan_test_skips_when_budget_exhausted():
    proj = _proj()
    conn = AsyncMock()
    with patch("services.projectors.test_planner.main._check_cpu_budget", return_value=False):
        with patch("services.projectors.test_planner.main._call_llm") as mock_llm:
            await proj._plan_test(conn, "hyp-fact-id")
            mock_llm.assert_not_called()


# ---------------------------------------------------------------------------
# _plan_test — invalid plan → no campaign created
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_plan_test_skips_no_project_id():
    proj = _proj()
    conn = AsyncMock()
    with patch("services.projectors.test_planner.main._check_cpu_budget", return_value=True):
        with patch("services.projectors.test_planner.main._fetch_hypothesis_fact", return_value={
            "id": "h1", "subject_label": "Compound", "subject_id_value": "CCO",
            "predicate": "mechanism_involves_pi_stacking",
            "object_value": {"value": True},
            "project_id": None, "confidence": 0.55, "derivation_class": "HYPOTHESIZED",
        }):
            with patch("services.projectors.test_planner.main._call_llm") as mock_llm:
                await proj._plan_test(conn, "h1")
                mock_llm.assert_not_called()


@pytest.mark.asyncio
async def test_plan_test_skips_invalid_plan():
    proj = _proj()
    conn = AsyncMock()
    invalid_plan = {"campaign_name": None, "campaign_kind": None, "steps": []}
    with patch("services.projectors.test_planner.main._check_cpu_budget", return_value=True):
        with patch("services.projectors.test_planner.main._fetch_hypothesis_fact", return_value={
            "id": "h1", "subject_label": "Compound", "subject_id_value": "CCO",
            "predicate": "mechanism_involves_pi_stacking",
            "object_value": {"value": True},
            "project_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "confidence": 0.55, "derivation_class": "HYPOTHESIZED",
        }):
            with patch("services.projectors.test_planner.main._load_prompt", return_value="sys"):
                with patch("services.projectors.test_planner.main._call_llm", return_value=invalid_plan):
                    with patch("services.projectors.test_planner.main._create_campaign") as mock_camp:
                        await proj._plan_test(conn, "h1")
                        mock_camp.assert_not_called()
