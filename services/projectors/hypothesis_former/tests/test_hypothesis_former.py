"""Unit tests for the hypothesis_former projector."""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.projectors.hypothesis_former.main import (
    HypothesisFormer,
    HypothesisFormerSettings,
    _MAX_HYPOTHESIS_CONFIDENCE,
    _call_llm,
)
from services.projectors.common.base import ProjectorSettings


def _settings() -> tuple[ProjectorSettings, HypothesisFormerSettings]:
    base = ProjectorSettings(
        postgres_host="localhost", postgres_port=5432,
        postgres_db="test", postgres_user="test", postgres_password="test",
    )
    hyp = HypothesisFormerSettings(
        postgres_host="localhost", postgres_port=5432,
        postgres_db="test", postgres_user="test", postgres_password="test",
        litellm_base_url="http://litellm:4000",
        litellm_api_key="test",
    )
    return base, hyp


def _proj() -> HypothesisFormer:
    return HypothesisFormer(*_settings())


def _good_hyp() -> dict[str, Any]:
    return {
        "predicate": "mechanism_involves_pi_stacking",
        "subject_label": "Compound",
        "subject_id_value": "c1ccccc1",
        "hypothesis_text": "The high yield is explained by pi-stacking stabilization.",
        "object_value": {"value": True},
        "confidence": 0.55,
        "supporting_fact_ids": [],
    }


# ---------------------------------------------------------------------------
# _call_llm
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_call_llm_returns_list():
    hyps = [_good_hyp()]
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"choices": [{"message": {"content": json.dumps(hyps)}}]}
    client = AsyncMock()
    client.post = AsyncMock(return_value=mock_resp)
    result = await _call_llm(client, _settings()[1], "sys", "usr")
    assert result == hyps


@pytest.mark.asyncio
async def test_call_llm_empty_on_server_error():
    mock_resp = MagicMock()
    mock_resp.status_code = 503
    mock_resp.text = "unavailable"
    client = AsyncMock()
    client.post = AsyncMock(return_value=mock_resp)
    result = await _call_llm(client, _settings()[1], "sys", "usr")
    assert result == []


@pytest.mark.asyncio
async def test_call_llm_empty_on_non_json():
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"choices": [{"message": {"content": "not json"}}]}
    client = AsyncMock()
    client.post = AsyncMock(return_value=mock_resp)
    result = await _call_llm(client, _settings()[1], "sys", "usr")
    assert result == []


# ---------------------------------------------------------------------------
# Constant checks
# ---------------------------------------------------------------------------


def test_max_hypothesis_confidence_capped():
    assert _MAX_HYPOTHESIS_CONFIDENCE <= 0.65


# ---------------------------------------------------------------------------
# handle() — missing fact_id for anomaly_observed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_anomaly_skips_when_no_fact_id():
    proj = _proj()
    # The handle method opens a connection before branching on event type.
    # When fact_id is missing, _form_from_anomaly logs a warning and returns
    # without calling LiteLLM. Verify no LLM call was made.
    with patch("services.projectors.hypothesis_former.main._call_llm") as mock_llm:
        with patch("psycopg.AsyncConnection.connect", new_callable=AsyncMock) as mock_conn:
            mock_conn.return_value.__aenter__ = AsyncMock(return_value=AsyncMock())
            mock_conn.return_value.__aexit__ = AsyncMock(return_value=None)
            await proj.handle(
                event_id="e1",
                event_type="anomaly_observed",
                source_table=None,
                source_row_id=None,
                payload={},
            )
            mock_llm.assert_not_called()


# ---------------------------------------------------------------------------
# _form_from_anomaly — budget gate and cap gate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_form_from_anomaly_skips_when_budget_exhausted():
    proj = _proj()
    conn = AsyncMock()
    with patch("services.projectors.hypothesis_former.main._check_daily_budget", return_value=False):
        with patch("services.projectors.hypothesis_former.main._call_llm") as mock_llm:
            await proj._form_from_anomaly(conn, "f1", {"anomaly_score": 0.9})
            mock_llm.assert_not_called()


@pytest.mark.asyncio
async def test_form_from_anomaly_skips_when_cap_reached():
    proj = _proj()
    proj._cfg.hypothesis_former_max_active_per_project = 2
    conn = AsyncMock()
    with patch("services.projectors.hypothesis_former.main._check_daily_budget", return_value=True):
        with patch("services.projectors.hypothesis_former.main._fetch_fact", return_value={
            "id": "f1", "subject_label": "Compound", "subject_id_value": "CCO",
            "predicate": "has_yield_pct", "object_value": {"value": 90.0},
            "unit": "%", "project_id": None, "confidence": 0.9,
        }):
            with patch("services.projectors.hypothesis_former.main._count_active_hypotheses", return_value=5):
                with patch("services.projectors.hypothesis_former.main._call_llm") as mock_llm:
                    await proj._form_from_anomaly(conn, "f1", {"anomaly_score": 0.9})
                    mock_llm.assert_not_called()


# ---------------------------------------------------------------------------
# Confidence clamping in _llm_and_insert
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_llm_and_insert_clamps_confidence():
    proj = _proj()
    inserted_confidences: list[float] = []

    async def mock_insert(conn: Any, raw: Any, project_id: Any, confidence: float, sfid: Any) -> str:
        inserted_confidences.append(confidence)
        return "hyp-id"

    async def mock_emit(*a: Any) -> None:
        pass

    with patch("services.projectors.hypothesis_former.main._call_llm",
               return_value=[{"predicate": "is_reactive", "subject_label": "Compound",
                              "subject_id_value": "CCO", "confidence": 1.0,
                              "object_value": {"value": True}}]):
        with patch("services.projectors.hypothesis_former.main._record_llm_spend"):
            with patch("services.projectors.hypothesis_former.main._insert_hypothesis",
                       side_effect=mock_insert):
                with patch("services.projectors.hypothesis_former.main._emit_hypothesis_proposed",
                           side_effect=mock_emit):
                    conn = AsyncMock()
                    await proj._llm_and_insert(conn, "sys", "user", None, None)

    assert inserted_confidences
    assert all(c <= _MAX_HYPOTHESIS_CONFIDENCE for c in inserted_confidences)
