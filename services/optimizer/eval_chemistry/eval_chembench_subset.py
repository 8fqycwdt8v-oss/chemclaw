"""ChemBench subset evaluation (Z7 task).

ChemBench is a 2700-question chemistry benchmark (Mirza et al., Nat. Chem. 2025;
github.com/lamalab-org/chembench). Two run modes:

  - **dispatch-only** (default). Reads the dataset, counts questions, returns
    status="skipped" with `passed=False` and a clear `reason`. Intended for
    CI smoke runs and dashboards that only want "did the harness load?".
  - **live scoring** (`CHEMBENCH_LIVE_SCORING=true`). POSTs each question to
    AGENT_BASE_URL/api/chat, parses the assistant's final text, compares
    against `expected_answer` (case-insensitive substring), and returns
    a real pass/fail decision against `target_pass_rate`.

The previous "placeholder" envelope (`status="placeholder", passed=False`)
was misleading — it looked like a real failure on dashboards. Today the
function only returns `passed=True` when scoring actually ran AND the
target was met; every other path returns a `status` that downstream
dashboards already know how to filter out.

Inputs (env or kwargs):
  CHEMBENCH_DATASET_PATH     — path to chembench questions JSONL
  CHEMBENCH_QUESTION_LIMIT   — defaults to 50 (subset of 2700)
  AGENT_BASE_URL             — defaults to http://localhost:3101
  CHEMBENCH_LIVE_SCORING     — 'true' to enable real scoring against the agent
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

import httpx


log = logging.getLogger(__name__)


def _is_truthy(env_value: str | None) -> bool:
    return (env_value or "").strip().lower() in ("1", "true", "yes", "on")


def _score_one(
    client: httpx.Client, agent_base_url: str, question: str,
    expected: str, timeout: float,
) -> bool:
    """POST a single question to the agent; case-insensitive substring match
    of expected against the assistant's final text. Caller catches
    httpx errors so the loop can keep going on transient failures.
    """
    resp = client.post(
        f"{agent_base_url.rstrip('/')}/api/chat",
        json={"prompt": question, "stream": False},
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()
    # Agent-claw's non-streaming response carries the assistant text under
    # `text`; tolerate older/alternate shapes (`response`, `message.content`).
    text = (
        data.get("text")
        or data.get("response")
        or (data.get("message") or {}).get("content")
        or ""
    )
    return expected.strip().lower() in text.lower()


def run(
    dataset_path: str | None = None,
    question_limit: int = 50,
    agent_base_url: str | None = None,
    target_pass_rate: float = 0.50,
) -> dict[str, Any]:
    csv_path = dataset_path or os.environ.get("CHEMBENCH_DATASET_PATH")
    if not csv_path or not Path(csv_path).exists():
        return {
            "task": "chembench_subset",
            "status": "skipped",
            "passed": False,
            "reason": "CHEMBENCH_DATASET_PATH not set; install ChemBench fixture and re-run",
            "target": {"pass_rate": target_pass_rate, "n_questions": question_limit},
        }

    rows: list[dict[str, Any]] = []
    with open(csv_path) as f:
        for i, line in enumerate(f):
            if i >= question_limit:
                break
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    n_total = len(rows)

    if not _is_truthy(os.environ.get("CHEMBENCH_LIVE_SCORING")):
        # Dataset loaded successfully; skip with a clear reason rather than
        # an opaque placeholder envelope.
        return {
            "task": "chembench_subset",
            "status": "skipped",
            "passed": False,
            "reason": (
                "live scoring disabled (set CHEMBENCH_LIVE_SCORING=true and "
                "ensure AGENT_BASE_URL is reachable to score)"
            ),
            "metrics": {"n_questions_loaded": n_total},
            "target": {"pass_rate": target_pass_rate},
        }

    base_url = agent_base_url or os.environ.get(
        "AGENT_BASE_URL", "http://localhost:3101"
    )
    timeout = float(os.environ.get("CHEMBENCH_TIMEOUT_SECONDS", "30"))

    n_correct = 0
    n_errors = 0
    with httpx.Client() as client:
        for row in rows:
            question = row.get("question")
            expected = row.get("expected_answer")
            if not isinstance(question, str) or not isinstance(expected, str):
                n_errors += 1
                continue
            try:
                if _score_one(client, base_url, question, expected, timeout):
                    n_correct += 1
            except (httpx.HTTPError, ValueError):
                # Transient agent / parse failure on a single question
                # shouldn't fail the whole run; record and move on.
                log.exception("chembench_subset: scoring error on one question")
                n_errors += 1

    pass_rate = (n_correct / n_total) if n_total else 0.0
    passed = n_total > 0 and pass_rate >= target_pass_rate

    return {
        "task": "chembench_subset",
        "status": "ok" if passed else "below_target",
        "passed": passed,
        "metrics": {
            "n_questions": n_total,
            "n_correct": n_correct,
            "n_errors": n_errors,
            "pass_rate": pass_rate,
        },
        "target": {"pass_rate": target_pass_rate},
    }
