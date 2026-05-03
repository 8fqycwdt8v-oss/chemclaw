"""Tests for the Z7 chemistry-eval runner."""
from __future__ import annotations

from services.optimizer.eval_chemistry.runner import list_tasks, run_task


def test_list_tasks():
    tasks = list_tasks()
    assert "doyle_buchwald" in tasks
    assert "chembench_subset" in tasks
    assert "pareto_simulation" in tasks


def test_run_unknown_task_returns_unknown():
    result = run_task("does_not_exist")
    assert result["status"] == "unknown"
    assert result["passed"] is False


def test_doyle_buchwald_skipped_without_dataset():
    result = run_task("doyle_buchwald")
    assert result["task"] == "doyle_buchwald"
    assert result["status"] == "skipped"
    assert result["passed"] is False


def test_chembench_skipped_without_dataset():
    result = run_task("chembench_subset")
    assert result["task"] == "chembench_subset"
    assert result["status"] == "skipped"
    assert result["passed"] is False


def test_pareto_simulation_runs_in_process():
    """The Pareto-simulation task is self-contained — should run + emit metrics."""
    result = run_task("pareto_simulation", n_grid=10, target_coverage=0.0)
    assert result["task"] == "pareto_simulation"
    # Either ok or skipped (if optimizer module missing).
    assert result["status"] in ("ok", "skipped")
    if result["status"] == "ok":
        assert "coverage" in result["metrics"]


def test_runner_catches_task_exceptions():
    """If a task raises, run_task wraps it as status=error."""
    from services.optimizer.eval_chemistry import runner as _runner

    original = _runner._TASK_REGISTRY["pareto_simulation"]

    def bad(*_args: object, **_kwargs: object) -> dict:
        raise RuntimeError("boom")

    _runner._TASK_REGISTRY["pareto_simulation"] = bad
    try:
        result = run_task("pareto_simulation")
        assert result["status"] == "error"
        assert "boom" in result["error"]
    finally:
        _runner._TASK_REGISTRY["pareto_simulation"] = original
