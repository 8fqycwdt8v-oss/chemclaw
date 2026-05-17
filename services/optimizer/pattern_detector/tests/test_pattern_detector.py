"""Unit tests for the pattern_detector daemon.

compute_cluster_stats is pure and fully testable without DB.
_fetch_compound_inchikeys and _emit_pattern_detected use AsyncMock DB connections.
"""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest

from services.optimizer.pattern_detector.main import (
    _emit_pattern_detected,
    _fetch_compound_inchikeys,
    compute_cluster_stats,
    _CV_THRESHOLD,
    _MIN_CLUSTER_SIZE,
)


# ---------------------------------------------------------------------------
# Async DB helper — fake connection factory
# ---------------------------------------------------------------------------


def _make_conn(fetchall_return=None):
    """Return a minimal AsyncMock connection that stubs cursor().execute/fetchall."""
    cur = AsyncMock()
    cur.execute = AsyncMock()
    cur.fetchall = AsyncMock(return_value=fetchall_return or [])

    @asynccontextmanager
    async def _cursor_ctx():
        yield cur

    conn = MagicMock()
    conn.cursor = _cursor_ctx
    return conn, cur


def test_returns_none_for_too_few_values():
    assert compute_cluster_stats([1.0, 2.0, 3.0]) is None


def test_returns_none_for_empty():
    assert compute_cluster_stats([]) is None


def test_returns_none_for_constant_population():
    # All same value: cv=0, stdev=0, range=0 → both thresholds fail
    assert compute_cluster_stats([42.0] * 10) is None


def test_returns_stats_for_high_cv():
    # Wide spread: cv >> CV_THRESHOLD
    values = [10.0, 20.0, 80.0, 90.0, 15.0, 85.0]
    stats = compute_cluster_stats(values)
    assert stats is not None
    assert stats["count"] == 6
    assert stats["min"] == pytest.approx(10.0)
    assert stats["max"] == pytest.approx(90.0)


def test_stats_contain_required_keys():
    values = [10.0, 50.0, 90.0, 30.0, 70.0, 20.0]
    stats = compute_cluster_stats(values)
    assert stats is not None
    for key in ("count", "mean", "stdev", "min", "max", "q1", "q3", "cv", "range"):
        assert key in stats


def test_spread_population_is_detected():
    # Very wide range ensures cv OR range threshold fires.
    values = [1.0, 10.0, 50.0, 90.0, 100.0, 5.0]
    stats = compute_cluster_stats(values)
    assert stats is not None


def test_mean_is_correct():
    values = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0]
    stats = compute_cluster_stats(values)
    assert stats is not None
    assert stats["mean"] == pytest.approx(35.0)


def test_stdev_positive_for_spread():
    values = [1.0, 10.0, 100.0, 50.0, 25.0, 75.0]
    stats = compute_cluster_stats(values)
    if stats is not None:
        assert stats["stdev"] > 0


def test_range_equals_max_minus_min():
    values = [5.0, 15.0, 25.0, 35.0, 45.0, 55.0]
    stats = compute_cluster_stats(values)
    if stats is not None:
        assert stats["range"] == pytest.approx(stats["max"] - stats["min"])


def test_min_cluster_size_constant():
    assert _MIN_CLUSTER_SIZE >= 3


def test_cv_threshold_constant():
    assert 0 < _CV_THRESHOLD < 1.0


# ---------------------------------------------------------------------------
# _fetch_compound_inchikeys
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_compound_inchikeys_returns_list():
    rows = [{"subject_id_value": "AAAA"}, {"subject_id_value": "BBBB"}]
    conn, cur = _make_conn(fetchall_return=rows)
    result = await _fetch_compound_inchikeys(conn, "boiling_point")
    assert result == ["AAAA", "BBBB"]
    cur.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_fetch_compound_inchikeys_filters_none():
    rows = [{"subject_id_value": "AAAA"}, {"subject_id_value": None}, {"subject_id_value": "CCCC"}]
    conn, _ = _make_conn(fetchall_return=rows)
    result = await _fetch_compound_inchikeys(conn, "melting_point")
    assert result == ["AAAA", "CCCC"]


@pytest.mark.asyncio
async def test_fetch_compound_inchikeys_empty_table():
    conn, _ = _make_conn(fetchall_return=[])
    result = await _fetch_compound_inchikeys(conn, "solubility")
    assert result == []


@pytest.mark.asyncio
async def test_fetch_compound_inchikeys_tuple_rows():
    rows = [("IK1",), ("IK2",)]
    conn, _ = _make_conn(fetchall_return=rows)
    result = await _fetch_compound_inchikeys(conn, "logp")
    assert result == ["IK1", "IK2"]


# ---------------------------------------------------------------------------
# _emit_pattern_detected
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_emit_pattern_detected_includes_inchikeys():
    inchikeys = ["INCHIKEYAAA", "INCHIKEYBBB"]

    # Two separate cursors: one for _fetch_compound_inchikeys, one for the INSERT
    fetch_cur = AsyncMock()
    fetch_cur.execute = AsyncMock()
    fetch_cur.fetchall = AsyncMock(return_value=[{"subject_id_value": k} for k in inchikeys])

    insert_cur = AsyncMock()
    insert_cur.execute = AsyncMock()

    call_count = 0

    @asynccontextmanager
    async def _cursor_ctx():
        nonlocal call_count
        call_count += 1
        yield fetch_cur if call_count == 1 else insert_cur

    conn = MagicMock()
    conn.cursor = _cursor_ctx

    await _emit_pattern_detected(conn, "boiling_point", {"count": 5, "mean": 100.0})

    insert_args = insert_cur.execute.call_args[0]
    # execute(sql, (json_string,)) — params is the second positional arg
    payload = json.loads(insert_args[1][0])
    assert payload["predicate"] == "boiling_point"
    assert payload["compound_inchikeys"] == inchikeys
    assert "cluster" in payload


@pytest.mark.asyncio
async def test_emit_pattern_detected_empty_inchikeys():
    fetch_cur = AsyncMock()
    fetch_cur.execute = AsyncMock()
    fetch_cur.fetchall = AsyncMock(return_value=[])

    insert_cur = AsyncMock()
    insert_cur.execute = AsyncMock()

    call_count = 0

    @asynccontextmanager
    async def _cursor_ctx():
        nonlocal call_count
        call_count += 1
        yield fetch_cur if call_count == 1 else insert_cur

    conn = MagicMock()
    conn.cursor = _cursor_ctx

    await _emit_pattern_detected(conn, "solubility", {"count": 6, "mean": 0.5})

    insert_args = insert_cur.execute.call_args[0]
    payload = json.loads(insert_args[1][0])
    assert payload["compound_inchikeys"] == []
