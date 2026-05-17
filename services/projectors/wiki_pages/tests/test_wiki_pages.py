"""Unit tests for wiki_pages projector Phase 7 additions.

Tests for the new `anomaly_observed` and `pattern_detected` event handlers.
The projector's DB interactions are mocked via AsyncMock so no real Postgres
connection is needed.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.projectors.wiki_pages.main import WikiPagesProjector
from services.projectors.common.base import ProjectorSettings


def _proj() -> WikiPagesProjector:
    return WikiPagesProjector(
        ProjectorSettings(
            postgres_host="localhost", postgres_port=5432,
            postgres_db="test", postgres_user="test", postgres_password="test",
        )
    )


def _mock_conn(fact_row: dict[str, Any] | None = None) -> MagicMock:
    """Mock an async psycopg connection that returns fact_row from fetchone."""
    mock_cur = AsyncMock()
    mock_cur.__aenter__ = AsyncMock(return_value=mock_cur)
    mock_cur.__aexit__ = AsyncMock(return_value=None)
    mock_cur.execute = AsyncMock()
    mock_cur.rowcount = 0
    mock_cur.fetchone = AsyncMock(return_value=fact_row)
    mock_conn = AsyncMock()
    mock_conn.cursor = MagicMock(return_value=mock_cur)
    mock_conn.commit = AsyncMock()
    return mock_conn


# ---------------------------------------------------------------------------
# _handle_anomaly_observed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_anomaly_observed_marks_compound_page_dirty():
    proj = _proj()
    fact = {
        "subject_label": "Compound",
        "subject_id_value": "ABCDEFGHIJKLMNO",
        "project_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    }
    conn = _mock_conn(fact_row=fact)
    with patch.object(proj, "_touch_page", new=AsyncMock()) as mock_touch:
        await proj._handle_anomaly_observed(
            conn, "evt-1", {"fact_id": "ffffffff-ffff-ffff-ffff-ffffffffffff"}
        )
        mock_touch.assert_awaited_once()
        call_kwargs = mock_touch.call_args.kwargs
        assert call_kwargs["slug"] == "compound/ABCDEFGHIJKLMNO"
        assert call_kwargs["kind"] == "compound"


@pytest.mark.asyncio
async def test_anomaly_observed_skips_non_compound_subject():
    proj = _proj()
    fact = {
        "subject_label": "Reaction",
        "subject_id_value": "some-reaction-id",
        "project_id": None,
    }
    conn = _mock_conn(fact_row=fact)
    with patch.object(proj, "_touch_page", new=AsyncMock()) as mock_touch:
        await proj._handle_anomaly_observed(
            conn, "evt-2", {"fact_id": "ffffffff-ffff-ffff-ffff-ffffffffffff"}
        )
        mock_touch.assert_not_awaited()


@pytest.mark.asyncio
async def test_anomaly_observed_skips_missing_fact_id():
    proj = _proj()
    conn = _mock_conn()
    with patch.object(proj, "_touch_page", new=AsyncMock()) as mock_touch:
        await proj._handle_anomaly_observed(conn, "evt-3", {})
        mock_touch.assert_not_awaited()


@pytest.mark.asyncio
async def test_anomaly_observed_skips_fact_not_found():
    proj = _proj()
    conn = _mock_conn(fact_row=None)
    with patch.object(proj, "_touch_page", new=AsyncMock()) as mock_touch:
        await proj._handle_anomaly_observed(
            conn, "evt-4", {"fact_id": "ffffffff-ffff-ffff-ffff-ffffffffffff"}
        )
        mock_touch.assert_not_awaited()


# ---------------------------------------------------------------------------
# _handle_pattern_detected
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pattern_detected_marks_multiple_compounds():
    proj = _proj()
    conn = _mock_conn()
    with patch.object(proj, "_touch_page", new=AsyncMock()) as mock_touch:
        await proj._handle_pattern_detected(
            conn, "evt-5",
            {
                "pattern_id": "patt-0001",
                "compound_inchikeys": ["IK1234567890123", "IK9876543210987"],
            },
        )
        assert mock_touch.await_count == 2
        slugs = {call.kwargs["slug"] for call in mock_touch.call_args_list}
        assert "compound/IK1234567890123" in slugs
        assert "compound/IK9876543210987" in slugs


@pytest.mark.asyncio
async def test_pattern_detected_skips_empty_list():
    proj = _proj()
    conn = _mock_conn()
    with patch.object(proj, "_touch_page", new=AsyncMock()) as mock_touch:
        await proj._handle_pattern_detected(conn, "evt-6", {"pattern_id": "p1", "compound_inchikeys": []})
        mock_touch.assert_not_awaited()


@pytest.mark.asyncio
async def test_pattern_detected_skips_missing_compound_inchikeys():
    proj = _proj()
    conn = _mock_conn()
    with patch.object(proj, "_touch_page", new=AsyncMock()) as mock_touch:
        await proj._handle_pattern_detected(conn, "evt-7", {"pattern_id": "p1"})
        mock_touch.assert_not_awaited()


@pytest.mark.asyncio
async def test_pattern_detected_skips_non_string_inchikeys():
    proj = _proj()
    conn = _mock_conn()
    with patch.object(proj, "_touch_page", new=AsyncMock()) as mock_touch:
        await proj._handle_pattern_detected(
            conn, "evt-8", {"pattern_id": "p1", "compound_inchikeys": [None, 42, ""]}
        )
        mock_touch.assert_not_awaited()


# ---------------------------------------------------------------------------
# interested_event_types includes the two new events
# ---------------------------------------------------------------------------


def test_event_types_include_anomaly_and_pattern():
    proj = _proj()
    assert "anomaly_observed" in proj.interested_event_types
    assert "pattern_detected" in proj.interested_event_types
