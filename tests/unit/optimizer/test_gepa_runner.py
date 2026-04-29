"""Tests for GEPA runner integration — mocked Langfuse + DSPy. Phase E."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import dspy


# ---------------------------------------------------------------------------
# Mock Langfuse client
# ---------------------------------------------------------------------------

class MockLangfuseClient:
    def __init__(self, traces: list[dict] = None, scores: list[dict] = None) -> None:
        self._traces = traces or []
        self._scores = scores or []

    def fetch_traces_for_prompt(self, prompt_name: str, hours: int = 24) -> list[dict]:
        return self._traces

    def fetch_scores_for_trace(self, trace_id: str) -> list[dict]:
        return self._scores


# ---------------------------------------------------------------------------
# Mock DB helpers
# ---------------------------------------------------------------------------

def _make_mock_conn(prompts: list[dict], feedback_rows: list[dict] = None):
    conn = MagicMock()

    # First execute call → _fetch_active_prompts
    # Second execute call → _fetch_feedback_events
    # Third+ → _insert_candidate

    calls = []
    def execute_side_effect(sql, params=None):
        calls.append((sql, params))
        cursor = MagicMock()
        if "FROM prompt_registry" in sql:
            cursor.fetchall.return_value = [
                (p["id"], p["name"], p["version"], p["template"])
                for p in prompts
            ]
        elif "FROM feedback_events" in sql:
            cursor.fetchall.return_value = [
                (r["signal"], r.get("trace_id", ""), r.get("created_at"))
                for r in (feedback_rows or [])
            ]
        else:
            cursor.fetchall.return_value = []
        return cursor

    conn.execute = execute_side_effect
    conn.commit = MagicMock()
    conn.__enter__ = MagicMock(return_value=conn)
    conn.__exit__ = MagicMock(return_value=False)
    return conn


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestGepaNightly:
    """Integration tests for run_gepa_nightly with everything mocked."""

    @pytest.mark.asyncio
    async def test_skips_when_no_examples(self, tmp_path):
        """GEPA skips prompts with 0 examples (< min 30)."""
        from services.optimizer.gepa_runner.runner import run_gepa_nightly

        lf_client = MockLangfuseClient(traces=[])

        fixture = tmp_path / "golden.jsonl"
        fixture.write_text(
            '{"question":"q","answer":"a","expected_classes":["analytical"]}\n'
        )

        with patch("services.optimizer.gepa_runner.runner._configure_dspy_lm", return_value=None):
            with patch("services.optimizer.gepa_runner.runner._get_dsn", return_value="dummy"):
                with patch("psycopg.connect") as mock_connect:
                    mock_conn = _make_mock_conn(
                        prompts=[{"id": "abc", "name": "agent.system", "version": 1, "template": "T"}]
                    )
                    mock_connect.return_value.__enter__ = MagicMock(return_value=mock_conn)
                    mock_connect.return_value.__exit__ = MagicMock(return_value=False)

                    await run_gepa_nightly(
                        langfuse_client=lf_client,
                        fixture_path=str(fixture),
                    )

        from services.optimizer.gepa_runner.runner import _last_run_status
        assert _last_run_status == "ok"

    @pytest.mark.asyncio
    async def test_runs_gepa_with_sufficient_examples(self, tmp_path, monkeypatch):
        """With 30+ examples per class, GEPA runs and inserts a candidate."""
        from services.optimizer.gepa_runner import runner as runner_mod

        # Build 30 retrosynthesis examples (all same class to meet minimum for that class).
        traces = [
            {
                "id": f"t{i}",
                "input": {"messages": [{"role": "user", "content": "What retro route for aspirin?"}]},
                "output": {"answer": "Retrosynthesis answer."},
                "observations": [],
            }
            for i in range(31)
        ]

        lf_client = MockLangfuseClient(traces=traces)

        fixture = tmp_path / "golden.jsonl"
        fixture.write_text(
            '{"question":"What retro route?","answer":"retrosynthesis answer","expected_classes":["retrosynthesis"]}\n'
        )

        inserted: list[tuple] = []

        def fake_insert(conn, name, version, template, metadata):
            inserted.append((name, version))

        monkeypatch.setattr(runner_mod, "_insert_candidate", fake_insert)

        # Mock run_gepa to return a non-skipped result.
        fake_result = MagicMock()
        fake_result.skipped = False
        fake_result.new_template = "Optimised template"
        fake_result.golden_score = 0.82
        fake_result.feedback_rate = 0.6
        fake_result.gepa_metadata = {"generations": 30}

        with patch("services.optimizer.gepa_runner.runner._configure_dspy_lm", return_value=None):
            with patch("services.optimizer.gepa_runner.runner.run_gepa", return_value=fake_result):
                with patch("services.optimizer.gepa_runner.runner._get_dsn", return_value="dummy"):
                    with patch("psycopg.connect") as mock_connect:
                        mock_conn = _make_mock_conn(
                            prompts=[{"id": "abc", "name": "agent.system", "version": 1, "template": "T"}]
                        )
                        mock_connect.return_value.__enter__ = MagicMock(return_value=mock_conn)
                        mock_connect.return_value.__exit__ = MagicMock(return_value=False)

                        await runner_mod.run_gepa_nightly(
                            langfuse_client=lf_client,
                            fixture_path=str(fixture),
                        )

        assert ("agent.system", 1) in inserted

    def test_load_golden_examples_from_fixture(self, tmp_path):
        """_load_golden_examples reads fixture lines correctly."""
        from services.optimizer.gepa_runner.runner import _load_golden_examples

        fixture = tmp_path / "test_golden.jsonl"
        fixture.write_text(
            '{"question":"Q1","answer":"A1","expected_classes":["analytical"]}\n'
            '{"question":"Q2","answer":"A2","expected_classes":["retrosynthesis"]}\n'
        )

        examples = _load_golden_examples(str(fixture))
        assert len(examples) == 2
        assert examples[0].question == "Q1"
        assert examples[1].query_class == "retrosynthesis"

    def test_load_golden_missing_file_returns_empty(self):
        """Missing fixture returns empty list with a warning."""
        from services.optimizer.gepa_runner.runner import _load_golden_examples

        examples = _load_golden_examples("/nonexistent/path/golden.jsonl")
        assert examples == []

    def test_healthz_returns_ok_structure(self):
        """Health endpoint returns expected keys."""
        from services.optimizer.gepa_runner.runner import healthz

        result = healthz()
        assert result["service"] == "gepa-runner"
        assert "last_run_at" in result
        assert "last_run_status" in result
        assert "details" in result


# ---------------------------------------------------------------------------
# Phase G — DSPy LM configuration + aggregate /healthz status
# ---------------------------------------------------------------------------


class TestConfigureDspyLM:
    """The runner must wire DSPy to LiteLLM at startup so dspy.GEPA has an
    LM to call. Without this, every prompt errors and /healthz lies green."""

    def test_configure_uses_litellm_envs(self, monkeypatch):
        from services.optimizer.gepa_runner import runner as runner_mod

        monkeypatch.setenv("LITELLM_BASE_URL", "http://litellm:4000")
        monkeypatch.setenv("LITELLM_API_KEY", "sk-test")
        monkeypatch.setenv("GEPA_MODEL", "executor")

        captured: dict[str, object] = {}

        def fake_lm(model, **kwargs):
            captured["model"] = model
            captured.update(kwargs)
            return MagicMock(name="LM")

        monkeypatch.setattr("dspy.LM", fake_lm, raising=False)

        configured: dict[str, object] = {}

        def fake_configure(**kwargs):
            configured.update(kwargs)

        monkeypatch.setattr("dspy.configure", fake_configure)

        runner_mod._configure_dspy_lm()

        assert captured["model"] == "openai/executor"
        assert captured["api_base"] == "http://litellm:4000"
        assert captured["api_key"] == "sk-test"
        assert "lm" in configured

    def test_configure_raises_when_envs_missing(self, monkeypatch):
        """Refuse to silently start without an LM. The runner caller turns
        this into a `_last_run_status='error'` so /healthz is honest."""
        from services.optimizer.gepa_runner import runner as runner_mod

        monkeypatch.delenv("LITELLM_BASE_URL", raising=False)
        monkeypatch.delenv("LITELLM_API_KEY", raising=False)
        with pytest.raises(RuntimeError, match="LITELLM_BASE_URL"):
            runner_mod._configure_dspy_lm()


class TestAggregateStatus:
    """Per-prompt errors must NOT be masked by 'ok'. /healthz must surface
    'degraded' when any prompt errored so the operator notices."""

    @pytest.mark.asyncio
    async def test_per_prompt_error_yields_degraded(self, tmp_path, monkeypatch):
        from services.optimizer.gepa_runner import runner as runner_mod

        traces = [
            {
                "id": f"t{i}",
                "input": {"messages": [{"role": "user", "content": "What retro route?"}]},
                "output": {"answer": "x"},
                "observations": [],
            }
            for i in range(31)
        ]
        lf_client = MockLangfuseClient(traces=traces)

        fixture = tmp_path / "g.jsonl"
        fixture.write_text(
            '{"question":"q","answer":"a","expected_classes":["retrosynthesis"]}\n'
        )

        with patch(
            "services.optimizer.gepa_runner.runner.run_gepa",
            side_effect=RuntimeError("boom"),
        ):
            with patch(
                "services.optimizer.gepa_runner.runner._configure_dspy_lm",
                return_value=None,
            ):
                with patch(
                    "services.optimizer.gepa_runner.runner._get_dsn",
                    return_value="dummy",
                ):
                    with patch("psycopg.connect") as mock_connect:
                        mock_conn = _make_mock_conn(
                            prompts=[
                                {
                                    "id": "abc",
                                    "name": "agent.system",
                                    "version": 1,
                                    "template": "T",
                                }
                            ]
                        )
                        mock_connect.return_value.__enter__ = MagicMock(
                            return_value=mock_conn
                        )
                        mock_connect.return_value.__exit__ = MagicMock(return_value=False)

                        await runner_mod.run_gepa_nightly(
                            langfuse_client=lf_client,
                            fixture_path=str(fixture),
                        )

        from services.optimizer.gepa_runner.runner import (
            _last_run_status,
            _last_run_details,
        )

        assert _last_run_status == "degraded"
        assert _last_run_details["agent.system"]["status"] == "error"
