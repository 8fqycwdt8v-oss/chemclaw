"""Unit tests for the interpreter projector.

All DB-touching paths are mocked. Tests cover LLM call parsing,
confidence clamping, depth gating, and budget gating.
"""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.projectors.interpreter.main import (
    Interpreter,
    InterpreterSettings,
    _call_llm,
    _MAX_INTERPRETED_CONFIDENCE,
)
from services.projectors.common.base import ProjectorSettings


def _settings() -> tuple[ProjectorSettings, InterpreterSettings]:
    base = ProjectorSettings(
        postgres_host="localhost", postgres_port=5432,
        postgres_db="test", postgres_user="test", postgres_password="test",
    )
    interp = InterpreterSettings(
        postgres_host="localhost", postgres_port=5432,
        postgres_db="test", postgres_user="test", postgres_password="test",
        litellm_base_url="http://litellm:4000",
        litellm_api_key="test",
    )
    return base, interp


def _proj() -> Interpreter:
    return Interpreter(*_settings())


def _good_interp() -> dict[str, Any]:
    return {
        "predicate": "suggests_high_reactivity",
        "object_value": {"value": True},
        "unit": None,
        "confidence": 0.70,
        "reasoning": "Yield is high and temperature is elevated.",
    }


# ---------------------------------------------------------------------------
# _call_llm
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_call_llm_parses_valid_list():
    interpretations = [_good_interp()]
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"choices": [{"message": {"content": json.dumps(interpretations)}}]}
    client = AsyncMock()
    client.post = AsyncMock(return_value=mock_resp)
    result = await _call_llm(client, _settings()[1], "sys", "usr")
    assert result == interpretations


@pytest.mark.asyncio
async def test_call_llm_returns_empty_on_4xx():
    mock_resp = MagicMock()
    mock_resp.status_code = 500
    mock_resp.text = "error"
    client = AsyncMock()
    client.post = AsyncMock(return_value=mock_resp)
    result = await _call_llm(client, _settings()[1], "sys", "usr")
    assert result == []


@pytest.mark.asyncio
async def test_call_llm_returns_empty_on_non_json():
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"choices": [{"message": {"content": "not json"}}]}
    client = AsyncMock()
    client.post = AsyncMock(return_value=mock_resp)
    result = await _call_llm(client, _settings()[1], "sys", "usr")
    assert result == []


@pytest.mark.asyncio
async def test_call_llm_strips_fence():
    interpretations = [_good_interp()]
    content = f"```json\n{json.dumps(interpretations)}\n```"
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"choices": [{"message": {"content": content}}]}
    client = AsyncMock()
    client.post = AsyncMock(return_value=mock_resp)
    result = await _call_llm(client, _settings()[1], "sys", "usr")
    assert result == interpretations


# ---------------------------------------------------------------------------
# handle() gate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_skips_when_no_fact_id():
    proj = _proj()
    with patch("psycopg.AsyncConnection.connect") as mock:
        await proj.handle(
            event_id="e1",
            event_type="investigation_requested",
            source_table=None,
            source_row_id=None,
            payload={},
        )
        mock.assert_not_called()


# ---------------------------------------------------------------------------
# _interpret — depth cap
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_interpret_skips_at_max_depth():
    proj = _proj()
    proj._cfg.interpreter_max_derivation_depth = 3

    source_fact = {
        "id": "f1", "subject_label": "Compound", "subject_id_value": "CCO",
        "predicate": "has_yield_pct", "object_value": {"value": 85.0},
        "unit": "%", "project_id": None, "confidence": 0.85,
        "confidence_tier": "foundational", "derivation_depth": 3,
        "derivation_class": "COMPUTED",
    }

    async def _fetchone(*a: Any, **kw: Any) -> Any:
        return source_fact

    mock_cur = AsyncMock()
    mock_cur.__aenter__ = AsyncMock(return_value=mock_cur)
    mock_cur.__aexit__ = AsyncMock(return_value=None)
    mock_cur.fetchone = AsyncMock(side_effect=_fetchone)
    mock_cur.fetchall = AsyncMock(return_value=[])

    mock_conn = AsyncMock()
    mock_conn.cursor = MagicMock(return_value=mock_cur)

    with patch("services.projectors.interpreter.main._call_llm") as mock_llm:
        # budget check returns True, but depth cap should fire before LLM call
        with patch("services.projectors.interpreter.main._check_daily_budget", return_value=True):
            await proj._interpret(mock_conn, "f1")
        mock_llm.assert_not_called()


# ---------------------------------------------------------------------------
# Confidence clamping
# ---------------------------------------------------------------------------


def test_max_interpreted_confidence_is_capped():
    assert _MAX_INTERPRETED_CONFIDENCE <= 0.75


@pytest.mark.asyncio
async def test_interpret_clamps_confidence():
    """LLM returning confidence=1.0 must be clamped to MAX_INTERPRETED_CONFIDENCE."""
    proj = _proj()

    source_fact = {
        "id": "sf1", "subject_label": "Compound", "subject_id_value": "CCO",
        "predicate": "has_yield_pct", "object_value": {"value": 85.0},
        "unit": "%", "project_id": None, "confidence": 0.85,
        "confidence_tier": "foundational", "derivation_depth": 0,
        "derivation_class": "COMPUTED",
    }

    inserted_confidences: list[float] = []

    async def mock_insert(conn: Any, source_fact: Any, predicate: Any, object_value: Any,
                          unit: Any, confidence: float, derivation_depth: Any) -> str:
        inserted_confidences.append(confidence)
        return "new-fact-id"

    async def mock_emit(*a: Any) -> None:
        pass

    # Patch heavy DB + LLM operations
    with patch("services.projectors.interpreter.main._fetch_fact", return_value=source_fact):
        with patch("services.projectors.interpreter.main._check_daily_budget", return_value=True):
            with patch("services.projectors.interpreter.main._fetch_peer_facts", return_value=[]):
                with patch("services.projectors.interpreter.main._fetch_subject_facts", return_value=[]):
                    with patch("services.projectors.interpreter.main._load_prompt", return_value="sys"):
                        with patch("services.projectors.interpreter.main._record_llm_spend"):
                            with patch("services.projectors.interpreter.main._insert_interpreted_fact",
                                       side_effect=mock_insert):
                                with patch("services.projectors.interpreter.main._emit_interpretation_event",
                                           side_effect=mock_emit):
                                    with patch("services.projectors.interpreter.main._call_llm",
                                               return_value=[{"predicate": "is_reactive",
                                                              "object_value": {"value": True},
                                                              "confidence": 1.0}]):
                                        conn = AsyncMock()
                                        await proj._interpret(conn, "sf1")

    assert inserted_confidences
    assert all(c <= _MAX_INTERPRETED_CONFIDENCE for c in inserted_confidences)
