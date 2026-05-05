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


# ---------------------------------------------------------------------------
# Prompt-registry promotion (Phase E correction)
# ---------------------------------------------------------------------------

class TestPromptPromotionPass:
    """Verify shadow_until → active flips happen with the right gate."""

    def _make_prompt_conn(
        self,
        *,
        shadow_rows: list[tuple[str, int]],
        active_version: int | None = 1,
        active_mean: float | None = 0.70,
        shadow_mean: float = 0.85,
        shadow_count: int = 50,
    ) -> MagicMock:
        conn = MagicMock()
        events: list[tuple[str, Any]] = []

        def execute(sql: str, params=None):
            events.append((sql, params))
            cursor = MagicMock()
            text = sql.strip().upper()
            if "FROM PROMPT_REGISTRY" in text and "ACTIVE = FALSE" in text and "SHADOW_UNTIL" in text:
                cursor.fetchall.return_value = shadow_rows
            elif "FROM PROMPT_REGISTRY" in text and "ACTIVE = TRUE" in text:
                cursor.fetchone.return_value = (active_version,) if active_version else None
            elif "AVG(SCORE)::FLOAT8 AS MEAN_SCORE" in text:
                cursor.fetchone.return_value = (active_mean,)
            elif "SELECT KEY, AVG(VALUE::FLOAT8)" in text:
                cursor.fetchall.return_value = []
            elif "AVG(SCORE)::FLOAT8, COUNT(*)" in text:
                cursor.fetchone.return_value = (shadow_mean, shadow_count)
            else:
                cursor.fetchone.return_value = None
                cursor.fetchall.return_value = []
            return cursor

        conn.execute = execute
        conn.commit = MagicMock()
        conn._events = events
        return conn

    def test_promotes_when_shadow_beats_active_by_delta(self):
        from services.optimizer.skill_promoter.promoter import run_prompt_promotion_pass

        conn = self._make_prompt_conn(
            shadow_rows=[("agent.system", 2)],
            active_mean=0.70,
            shadow_mean=0.85,
        )
        events = run_prompt_promotion_pass(conn)
        assert len(events) == 1
        assert events[0].event_type == "shadow_promote"
        assert events[0].skill_name == "agent.system"
        assert events[0].version == 2
        update_count = sum(
            1 for sql, _ in conn._events if "UPDATE PROMPT_REGISTRY" in sql.upper()
        )
        # Atomic flip = deactivate prior active + activate candidate.
        assert update_count >= 2

    def test_rejects_when_shadow_below_floor(self):
        from services.optimizer.skill_promoter.promoter import run_prompt_promotion_pass

        conn = self._make_prompt_conn(
            shadow_rows=[("agent.system", 2)],
            active_mean=0.70,
            shadow_mean=0.75,
        )
        events = run_prompt_promotion_pass(conn)
        assert events[0].event_type == "shadow_reject"
        assert "floor" in events[0].reason

    def test_rejects_when_shadow_below_active_plus_delta(self):
        from services.optimizer.skill_promoter.promoter import run_prompt_promotion_pass

        conn = self._make_prompt_conn(
            shadow_rows=[("agent.system", 2)],
            active_mean=0.82,
            shadow_mean=0.84,
        )
        events = run_prompt_promotion_pass(conn)
        assert events[0].event_type == "shadow_reject"

    def test_returns_no_events_when_no_expired_shadows(self):
        from services.optimizer.skill_promoter.promoter import run_prompt_promotion_pass

        conn = self._make_prompt_conn(shadow_rows=[])
        events = run_prompt_promotion_pass(conn)
        assert events == []

    def test_rejects_when_no_shadow_runs_recorded(self):
        from services.optimizer.skill_promoter.promoter import run_prompt_promotion_pass

        conn = self._make_prompt_conn(
            shadow_rows=[("agent.system", 2)],
            shadow_mean=0.0,
            shadow_count=0,
        )
        events = run_prompt_promotion_pass(conn)
        assert events[0].event_type == "shadow_reject"
        assert events[0].reason == "no_shadow_runs_recorded"


class TestApplyConfigOverrides:
    """L8: promoter thresholds are now overridable via config_settings."""

    def test_apply_config_overrides_mutates_module_constants(self, monkeypatch):
        """When ConfigRegistry returns overrides, the module-level constants
        are updated. Defaults restored at fixture teardown."""
        from services.optimizer.skill_promoter import promoter
        from services.common import config_registry

        # Save originals to restore.
        orig_promotion = promoter.PROMOTION_SUCCESS_RATE
        orig_demotion = promoter.DEMOTION_SUCCESS_RATE
        orig_min = promoter.MIN_RUNS

        # Patch the registry to return tenant overrides.
        class _FakeRegistry:
            def __init__(self, dsn):  # noqa: ARG002
                pass
            def get_float(self, key, default, ctx=None):  # noqa: ARG002
                return {
                    "optimizer.promotion_success_rate": 0.70,
                    "optimizer.demotion_success_rate": 0.30,
                }[key]
            def get_int(self, key, default, ctx=None):  # noqa: ARG002
                return {"optimizer.min_runs": 50}[key]

        monkeypatch.setattr(config_registry, "ConfigRegistry", _FakeRegistry)

        try:
            promoter.apply_config_overrides("dsn-ignored")
            assert promoter.PROMOTION_SUCCESS_RATE == 0.70
            assert promoter.DEMOTION_SUCCESS_RATE == 0.30
            assert promoter.MIN_RUNS == 50
        finally:
            # Restore defaults so subsequent tests in the same process don't
            # see leaked state. The promoter module mutates its own globals,
            # so manual restoration is required.
            promoter.PROMOTION_SUCCESS_RATE = orig_promotion
            promoter.DEMOTION_SUCCESS_RATE = orig_demotion
            promoter.MIN_RUNS = orig_min

    def test_threshold_defaults_dict_preserves_originals(self):
        """The _THRESHOLD_DEFAULTS dict is the canonical source for the
        original values — used by `apply_config_overrides` as the fallback
        passed to ConfigRegistry's `default` arg."""
        from services.optimizer.skill_promoter.promoter import _THRESHOLD_DEFAULTS

        assert _THRESHOLD_DEFAULTS == {
            "PROMOTION_SUCCESS_RATE": 0.55,
            "DEMOTION_SUCCESS_RATE": 0.40,
            "MIN_RUNS": 30,
        }
