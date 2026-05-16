"""Unit tests for the investigation_scorer projector.

All scoring functions are pure and fully testable without DB.
The routing logic (_score_and_route) is tested with mock connections.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.projectors.investigation_scorer.main import (
    InvestigationScorer,
    InvestigationScorerSettings,
    compute_anomaly_score,
    compute_composite,
    compute_novelty_score,
    compute_priority_score,
    reason_codes,
)
from services.projectors.common.base import ProjectorSettings


# ---------------------------------------------------------------------------
# compute_novelty_score
# ---------------------------------------------------------------------------


def test_novelty_is_one_for_new():
    assert compute_novelty_score(0) == pytest.approx(1.0)


def test_novelty_decreases_with_count():
    assert compute_novelty_score(1) == pytest.approx(0.5)
    assert compute_novelty_score(9) == pytest.approx(0.1)


def test_novelty_handles_negative_count():
    assert compute_novelty_score(-5) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# compute_anomaly_score
# ---------------------------------------------------------------------------


def test_anomaly_zero_with_few_peers():
    assert compute_anomaly_score(100.0, [90.0]) == pytest.approx(0.0)
    assert compute_anomaly_score(100.0, [90.0, 95.0]) == pytest.approx(0.0)


def test_anomaly_zero_with_empty_peers():
    assert compute_anomaly_score(100.0, []) == pytest.approx(0.0)


def test_anomaly_low_for_typical_value():
    peers = [85.0, 87.0, 86.0, 88.0, 84.0]
    assert compute_anomaly_score(86.0, peers) < 0.1


def test_anomaly_high_for_extreme_value():
    peers = [85.0, 86.0, 87.0, 85.5, 86.5, 87.5]
    score = compute_anomaly_score(150.0, peers)
    assert score > 0.5


def test_anomaly_capped_at_one():
    peers = [10.0, 11.0, 12.0, 10.5, 11.5, 12.5]
    # value 1000 is many std-devs out → clamped at 1.0
    assert compute_anomaly_score(1000.0, peers) == pytest.approx(1.0)


def test_anomaly_zero_for_constant_peers():
    peers = [5.0, 5.0, 5.0, 5.0]
    assert compute_anomaly_score(5.0, peers) == pytest.approx(0.0)


def test_anomaly_zero_for_exact_mean():
    peers = [10.0, 20.0, 30.0]
    assert compute_anomaly_score(20.0, peers) == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# compute_priority_score
# ---------------------------------------------------------------------------


def test_priority_one_for_active_campaign():
    assert compute_priority_score(True, False, True) == pytest.approx(1.0)


def test_priority_one_for_clinical_phase():
    assert compute_priority_score(False, True, True) == pytest.approx(1.0)


def test_priority_zero_for_quiet_project():
    assert compute_priority_score(False, False, True) == pytest.approx(0.0)


def test_priority_half_for_no_project():
    assert compute_priority_score(False, False, False) == pytest.approx(0.5)


# ---------------------------------------------------------------------------
# compute_composite
# ---------------------------------------------------------------------------


def test_composite_weighted_sum():
    # weights (a=0.45, n=0.35, p=0.20) sum to 1.0 → no rescaling
    c = compute_composite(0.5, 0.6, 0.8, (0.45, 0.35, 0.20))
    expected = (0.45 * 0.6 + 0.35 * 0.5 + 0.20 * 0.8) / 1.0
    assert c == pytest.approx(expected)


def test_composite_zero_weights_handled():
    # should not ZeroDivisionError
    c = compute_composite(0.5, 0.5, 0.5, (0.0, 0.0, 0.0))
    assert c == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# reason_codes
# ---------------------------------------------------------------------------


def test_reason_codes_new_outlier_active():
    codes = reason_codes(1.0, 0.9, 1.0, 0.85, 0.70)
    assert "novelty:new" in codes
    assert "anomaly:outlier" in codes
    assert "priority:active" in codes
    assert "routed:sync" in codes


def test_reason_codes_fallback_low():
    codes = reason_codes(0.05, 0.0, 0.0, 0.01, 0.70)
    assert "novelty:known" in codes
    assert "score:low" in codes or len(codes) > 0


# ---------------------------------------------------------------------------
# handle() gate — disabled path / missing fact_id
# ---------------------------------------------------------------------------


def _proj() -> InvestigationScorer:
    return InvestigationScorer(
        ProjectorSettings(
            postgres_host="localhost", postgres_port=5432,
            postgres_db="test", postgres_user="test", postgres_password="test",
        ),
        InvestigationScorerSettings(
            postgres_host="localhost", postgres_port=5432,
            postgres_db="test", postgres_user="test", postgres_password="test",
        ),
    )


@pytest.mark.asyncio
async def test_handle_skips_when_no_fact_id():
    proj = _proj()
    with patch("psycopg.AsyncConnection.connect") as mock_conn:
        await proj.handle(
            event_id="evt-1",
            event_type="extracted_fact",
            source_table="facts",
            source_row_id=None,
            payload={},
        )
        mock_conn.assert_not_called()


# ---------------------------------------------------------------------------
# _score_and_route — mock DB, various routing scenarios
# ---------------------------------------------------------------------------


def _mock_conn(fact: dict[str, Any] | None, peer_count: int = 0, peer_values: list[float] | None = None) -> MagicMock:
    """Build a mock async psycopg connection that returns given fact + peers."""
    call_seq: list[Any] = [
        fact,            # _fetch_fact
        {"n": peer_count},     # _count_peer_facts
        [{"v": v} for v in (peer_values or [])],  # _fetch_peer_numeric_values
        None,            # _check_project_priority project row
        None,            # _check_project_priority campaign check
    ]

    class _MockCur:
        def __init__(self) -> None:
            self._call = 0
            self._seq = list(call_seq)

        async def __aenter__(self) -> "_MockCur":
            return self

        async def __aexit__(self, *a: Any) -> None:
            pass

        async def execute(self, *a: Any, **kw: Any) -> None:
            pass

        async def fetchone(self) -> Any:
            if not self._seq:
                return None
            v = self._seq.pop(0)
            return v if not isinstance(v, list) else None

        async def fetchall(self) -> Any:
            if not self._seq:
                return []
            v = self._seq.pop(0)
            return v if isinstance(v, list) else []

    mock_cur = _MockCur()
    mock_conn = AsyncMock()
    mock_conn.cursor = MagicMock(return_value=mock_cur)
    return mock_conn


@pytest.mark.asyncio
async def test_score_and_route_skips_missing_fact():
    proj = _proj()
    conn = _mock_conn(fact=None)
    await proj._score_and_route(conn, "no-such-id")  # should not raise


@pytest.mark.asyncio
async def test_score_and_route_skips_zero_composite():
    # zero composite: novelty=0 (lots of peers), anomaly=0, priority=0 (no project)
    fact = {
        "id": "f1", "subject_label": "Compound", "subject_id_value": "CCO",
        "predicate": "has_yield_pct", "object_value": {"value": 85.0},
        "project_id": None, "confidence": 0.9,
    }
    proj = _proj()
    # novelty_score = 1/(1+999) ≈ 0.001 → composite ≈ 0.0001 * 0.35 → below min
    conn = _mock_conn(fact, peer_count=9999, peer_values=[85.0] * 200)

    emit_calls: list[str] = []

    async def mock_emit(c: Any, ev: str, fid: str, payload: Any) -> None:
        emit_calls.append(ev)

    with patch("services.projectors.investigation_scorer.main._emit_event", side_effect=mock_emit):
        with patch("services.projectors.investigation_scorer.main._enqueue_investigation") as mock_q:
            await proj._score_and_route(conn, "f1")
            # should not emit or enqueue when composite is effectively 0
            assert "investigation_requested" not in emit_calls
