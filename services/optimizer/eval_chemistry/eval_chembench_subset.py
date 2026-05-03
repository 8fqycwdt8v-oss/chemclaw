"""ChemBench subset evaluation (Z7 task — placeholder).

ChemBench is a 2700-question chemistry benchmark (Mirza et al., Nat. Chem. 2025;
github.com/lamalab-org/chembench). The full implementation requires:
  1. Downloading the ChemBench dataset.
  2. Routing each question through the agent harness via /api/chat.
  3. Scoring the response via the dataset's reference-answer scorer.

This Z7 placeholder scaffolds the task contract so /eval can dispatch it; a
production deploy wires CHEMBENCH_DATASET_PATH and an agent base URL. The
placeholder run() returns status="skipped" until both are set.

Inputs (env or kwargs):
  CHEMBENCH_DATASET_PATH     — local path to chembench questions JSONL
  CHEMBENCH_QUESTION_LIMIT   — defaults to 50 (subset of 2700)
  AGENT_BASE_URL             — defaults to http://localhost:3101
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


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

    # Minimal scoring loop — assumes JSONL with {question, expected_answer, type}.
    n_correct = 0
    n_total = 0
    with open(csv_path) as f:
        for i, line in enumerate(f):
            if i >= question_limit:
                break
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            n_total += 1
            # Real implementation would route question through the agent and
            # check expected_answer. Placeholder marks as unscored.
            _ = row
        # Unscored placeholder: don't claim correctness.

    return {
        "task": "chembench_subset",
        "status": "placeholder",
        "passed": False,
        "reason": "scoring loop not yet wired to agent; structure validates only",
        "metrics": {
            "n_questions_seen": n_total,
            "n_correct_unscored": n_correct,
        },
        "target": {"pass_rate": target_pass_rate},
    }
