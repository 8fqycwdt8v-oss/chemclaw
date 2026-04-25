"""Tests for skill promoter — Phase E."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from services.optimizer.skill_promoter.promoter import (
    SkillRow,
    PromotionEvent,
    _success_rate,
    run_promotion_pass,
    PROMOTION_SUCCESS_RATE,
    DEMOTION_SUCCESS_RATE,
    MIN_RUNS,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_skill(
    *,
    active: bool,
    success: int,
    total: int,
    kind: str = "prompt",
    name: str = "test_skill",
    version: int = 1,
) -> SkillRow:
    return SkillRow(
        id="id-1",
        name=name,
        version=version,
        kind=kind,
        active=active,
        success_count=success,
        total_runs=total,
        proposed_by_user_entra_id="user@example.com",
    )


def _make_mock_conn(skills: list[SkillRow], validator_status: str | None = "passing"):
    conn = MagicMock()
    # Main execute: return skill rows
    main_cursor = MagicMock()
    main_cursor.fetchall.return_value = [
        (s.id, s.name, s.version, s.kind, s.active,
         s.success_count, s.total_runs, s.proposed_by_user_entra_id)
        for s in skills
    ]

    validator_cursor = MagicMock()
    validator_cursor.fetchone.return_value = (validator_status,) if validator_status else None

    call_count = [0]
    def execute_side(sql, params=None):
        call_count[0] += 1
        if "FROM skill_library" in sql:
            return main_cursor
        if "FROM forged_tool_validation_runs" in sql:
            return validator_cursor
        return MagicMock(fetchall=MagicMock(return_value=[]), fetchone=MagicMock(return_value=None))

    conn.execute = execute_side
    conn.commit = MagicMock()
    return conn


# ---------------------------------------------------------------------------
# Tests for _success_rate
# ---------------------------------------------------------------------------

class TestSuccessRate:
    def test_above_min_runs(self):
        skill = _make_skill(active=True, success=25, total=30)
        rate = _success_rate(skill)
        assert abs(rate - 25/30) < 1e-9

    def test_below_min_runs_returns_none(self):
        skill = _make_skill(active=True, success=20, total=29)
        assert _success_rate(skill) is None

    def test_exact_min_runs(self):
        skill = _make_skill(active=True, success=MIN_RUNS, total=MIN_RUNS)
        rate = _success_rate(skill)
        assert rate == 1.0


# ---------------------------------------------------------------------------
# Tests for run_promotion_pass
# ---------------------------------------------------------------------------

class TestRunPromotionPass:
    def test_promotes_inactive_skill_above_threshold(self):
        """Inactive skill with rate >= 0.55 and >= 30 runs is promoted."""
        skill = _make_skill(active=False, success=20, total=30)
        conn = _make_mock_conn([skill])

        events = run_promotion_pass(conn)

        promote_events = [e for e in events if e.event_type == "promote"]
        assert len(promote_events) == 1
        assert promote_events[0].skill_name == "test_skill"

    def test_does_not_promote_below_threshold(self):
        """Inactive skill with rate < 0.55 is not promoted."""
        skill = _make_skill(active=False, success=16, total=30)  # rate=0.533 < 0.55
        conn = _make_mock_conn([skill])

        events = run_promotion_pass(conn)
        assert not any(e.event_type == "promote" for e in events)

    def test_demotes_active_skill_below_demotion_threshold(self):
        """Active skill with rate < 0.40 is demoted."""
        skill = _make_skill(active=True, success=11, total=30)  # rate=0.367 < 0.40
        conn = _make_mock_conn([skill])

        events = run_promotion_pass(conn)

        demote_events = [e for e in events if e.event_type == "demote"]
        assert len(demote_events) == 1

    def test_forged_tool_requires_passing_validator(self):
        """Forged tool only promoted when validator status='passing'."""
        skill = _make_skill(active=False, success=20, total=30, kind="forged_tool")
        conn = _make_mock_conn([skill], validator_status="degraded")

        events = run_promotion_pass(conn)
        assert not any(e.event_type == "promote" for e in events)

    def test_forged_tool_promoted_when_passing(self):
        """Forged tool promoted when rate OK and validator='passing'."""
        skill = _make_skill(active=False, success=20, total=30, kind="forged_tool")
        conn = _make_mock_conn([skill], validator_status="passing")

        events = run_promotion_pass(conn)
        assert any(e.event_type == "promote" for e in events)

    def test_skips_skills_below_min_runs(self):
        """Skills with < MIN_RUNS total runs are skipped entirely."""
        skill = _make_skill(active=False, success=20, total=MIN_RUNS - 1)
        conn = _make_mock_conn([skill])

        events = run_promotion_pass(conn)
        assert len(events) == 0
