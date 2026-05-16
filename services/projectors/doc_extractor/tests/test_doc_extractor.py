"""Unit tests for the doc_extractor projector.

Uses unittest.mock — no DB, no LiteLLM, no network.
"""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.projectors.doc_extractor.main import (
    DocExtractorProjector,
    DocExtractorSettings,
    _call_llm,
    _clamp_confidence,
    _confidence_tier,
    _valid_fact,
)
from services.projectors.common.base import ProjectorSettings


# ---------------------------------------------------------------------------
# Helper factories
# ---------------------------------------------------------------------------


def _base_settings() -> ProjectorSettings:
    return ProjectorSettings(
        postgres_host="localhost",
        postgres_port=5432,
        postgres_db="test",
        postgres_user="test",
        postgres_password="test",
    )


def _ext_settings(enabled: bool = True) -> DocExtractorSettings:
    return DocExtractorSettings(
        postgres_host="localhost",
        postgres_port=5432,
        postgres_db="test",
        postgres_user="test",
        postgres_password="test",
        litellm_base_url="http://litellm:4000",
        litellm_api_key="test-key",
        doc_extractor_enabled=enabled,
    )


def _good_fact() -> dict[str, Any]:
    return {
        "subject_label": "Compound",
        "subject_id_value": "CCO",
        "predicate": "has_yield_pct",
        "object_value": {"value": 85.0},
        "unit": "%",
        "derivation_class": "COMPUTED",
        "confidence": 0.80,
        "confidence_tier": "high",
        "extractor_name": "doc_extractor",
    }


# ---------------------------------------------------------------------------
# _valid_fact
# ---------------------------------------------------------------------------


def test_valid_fact_accepts_good():
    assert _valid_fact(_good_fact()) is True


def test_valid_fact_rejects_none():
    assert _valid_fact(None) is False


def test_valid_fact_rejects_missing_predicate():
    f = _good_fact()
    del f["predicate"]
    assert _valid_fact(f) is False


def test_valid_fact_rejects_empty_subject_id():
    f = _good_fact()
    f["subject_id_value"] = ""
    assert _valid_fact(f) is False


def test_valid_fact_rejects_missing_object_value():
    f = _good_fact()
    del f["object_value"]
    assert _valid_fact(f) is False


# ---------------------------------------------------------------------------
# _clamp_confidence
# ---------------------------------------------------------------------------


def test_clamp_confidence_normal():
    assert _clamp_confidence(0.75) == pytest.approx(0.75)


def test_clamp_confidence_caps_at_085():
    assert _clamp_confidence(1.0) == pytest.approx(0.85)


def test_clamp_confidence_floors_at_0():
    assert _clamp_confidence(-0.5) == pytest.approx(0.0)


def test_clamp_confidence_handles_string():
    assert _clamp_confidence("0.65") == pytest.approx(0.65)


def test_clamp_confidence_returns_040_on_invalid():
    assert _clamp_confidence("bad") == pytest.approx(0.40)


# ---------------------------------------------------------------------------
# _confidence_tier
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "conf,expected",
    [
        (0.85, "foundational"),
        (0.70, "high"),
        (0.50, "medium"),
        (0.25, "low"),
        (0.10, "exploratory"),
    ],
)
def test_confidence_tier(conf: float, expected: str) -> None:
    assert _confidence_tier(conf) == expected


# ---------------------------------------------------------------------------
# _call_llm — mock httpx
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_call_llm_returns_parsed_list():
    facts = [_good_fact()]
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "choices": [{"message": {"content": json.dumps(facts)}}]
    }

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_response)

    result = await _call_llm(mock_client, _ext_settings(), "system", "user")
    assert result == facts


@pytest.mark.asyncio
async def test_call_llm_strips_markdown_fence():
    facts = [_good_fact()]
    content = f"```json\n{json.dumps(facts)}\n```"
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "choices": [{"message": {"content": content}}]
    }
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_response)

    result = await _call_llm(mock_client, _ext_settings(), "sys", "usr")
    assert result == facts


@pytest.mark.asyncio
async def test_call_llm_returns_empty_on_4xx():
    mock_response = MagicMock()
    mock_response.status_code = 429
    mock_response.text = "rate limited"
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_response)

    result = await _call_llm(mock_client, _ext_settings(), "sys", "usr")
    assert result == []


@pytest.mark.asyncio
async def test_call_llm_returns_empty_on_network_error():
    import httpx
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(side_effect=httpx.HTTPError("connection refused"))

    result = await _call_llm(mock_client, _ext_settings(), "sys", "usr")
    assert result == []


@pytest.mark.asyncio
async def test_call_llm_returns_empty_on_non_json():
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"choices": [{"message": {"content": "not json"}}]}
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_response)

    result = await _call_llm(mock_client, _ext_settings(), "sys", "usr")
    assert result == []


@pytest.mark.asyncio
async def test_call_llm_returns_empty_on_non_list():
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"choices": [{"message": {"content": '{"key": "val"}'}}]}
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_response)

    result = await _call_llm(mock_client, _ext_settings(), "sys", "usr")
    assert result == []


# ---------------------------------------------------------------------------
# DocExtractorProjector.handle — gate tests (no DB)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_skips_when_disabled():
    proj = DocExtractorProjector(_base_settings(), _ext_settings(enabled=False))
    # Should return immediately without touching psycopg
    with patch("psycopg.AsyncConnection.connect") as mock_conn:
        await proj.handle(
            event_id="evt-1",
            event_type="document_ingested",
            source_table="documents",
            source_row_id="doc-uuid",
            payload={"document_id": "doc-uuid"},
        )
        mock_conn.assert_not_called()


@pytest.mark.asyncio
async def test_handle_skips_when_no_document_id():
    proj = DocExtractorProjector(_base_settings(), _ext_settings(enabled=True))
    with patch("psycopg.AsyncConnection.connect") as mock_conn:
        await proj.handle(
            event_id="evt-2",
            event_type="document_ingested",
            source_table=None,
            source_row_id=None,
            payload={},
        )
        mock_conn.assert_not_called()


# ---------------------------------------------------------------------------
# _process_document — with mock conn
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_process_document_skips_missing_doc():
    proj = DocExtractorProjector(_base_settings(), _ext_settings())

    mock_cur = AsyncMock()
    mock_cur.__aenter__ = AsyncMock(return_value=mock_cur)
    mock_cur.__aexit__ = AsyncMock(return_value=None)
    mock_cur.fetchone = AsyncMock(return_value=None)

    mock_conn = AsyncMock()
    mock_conn.cursor = MagicMock(return_value=mock_cur)

    await proj._process_document(mock_conn, "evt-3", "no-such-id")


@pytest.mark.asyncio
async def test_process_document_skips_empty_chunks():
    proj = DocExtractorProjector(_base_settings(), _ext_settings())

    fetch_calls: list[Any] = []

    async def fetchone_side():
        call_n = len(fetch_calls)
        fetch_calls.append(call_n)
        if call_n == 0:
            return {"id": "doc-1", "sha256": "abc", "title": "T", "source_type": "SOP", "metadata": {}, "ingested_at": "2026-01-01"}
        return None

    mock_cur = AsyncMock()
    mock_cur.__aenter__ = AsyncMock(return_value=mock_cur)
    mock_cur.__aexit__ = AsyncMock(return_value=None)
    mock_cur.fetchone = AsyncMock(side_effect=fetchone_side)
    mock_cur.fetchall = AsyncMock(return_value=[])

    mock_conn = AsyncMock()
    mock_conn.cursor = MagicMock(return_value=mock_cur)

    # Should not raise and should not call LiteLLM
    with patch("services.projectors.doc_extractor.main._call_llm") as mock_llm:
        await proj._process_document(mock_conn, "evt-4", "doc-1")
        mock_llm.assert_not_called()
