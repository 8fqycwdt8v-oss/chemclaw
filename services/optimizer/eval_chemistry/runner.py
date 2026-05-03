"""Chemistry-evaluation runner — Phase Z7.

Dispatches by task name; each task is a pure function that returns a
structured result dict {task, status, metrics, passed, target}. Tasks
fetch live MCP services or read fixtures; results are JSON-serializable
so they can be printed to stdout (CLI), returned via /api/eval (route),
or written to a JSONL log (cron).

Built-in tasks:
  - doyle_buchwald   : RMSE + ECE on Doyle Buchwald-Hartwig HTE held-out
  - chembench_subset : minimal correctness pass on ChemBench question subset
  - pareto_simulation: synthetic BO replay; checks Pareto-front grows over rounds

Tasks are dispatched purely by name — no auto-discovery, no module reload.
"""
from __future__ import annotations

from typing import Any, Callable

from services.optimizer.eval_chemistry import (
    eval_chembench_subset,
    eval_doyle_buchwald,
    eval_pareto_simulation,
)

_TASK_REGISTRY: dict[str, Callable[..., dict[str, Any]]] = {
    "doyle_buchwald":    eval_doyle_buchwald.run,
    "chembench_subset":  eval_chembench_subset.run,
    "pareto_simulation": eval_pareto_simulation.run,
}


def list_tasks() -> list[str]:
    return list(_TASK_REGISTRY.keys())


def run_task(name: str, **kwargs: Any) -> dict[str, Any]:
    if name not in _TASK_REGISTRY:
        return {
            "task": name,
            "status": "unknown",
            "passed": False,
            "error": f"unknown task; choose one of: {sorted(_TASK_REGISTRY)}",
        }
    fn = _TASK_REGISTRY[name]
    try:
        return fn(**kwargs)
    except Exception as exc:  # noqa: BLE001 — catch-all for eval tasks; result is the message
        return {
            "task": name,
            "status": "error",
            "passed": False,
            "error": f"{type(exc).__name__}: {exc}",
        }
