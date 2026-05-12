"""Unit tests for the ChemBench subset eval task.

Verifies the envelope contract: missing dataset → status='skipped'; dataset
present but live scoring disabled → status='skipped' with a different
reason; live scoring enabled → status reflects pass-rate vs. target. The
HTTP path is mocked so tests don't need a running agent.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx
import pytest

from services.optimizer.eval_chemistry import eval_chembench_subset


def _write_jsonl(tmp: Path, rows: list[dict[str, Any]]) -> Path:
    p = tmp / "chembench.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in rows))
    return p


def test_missing_dataset_returns_skipped():
    res = eval_chembench_subset.run(dataset_path="/does/not/exist")
    assert res["task"] == "chembench_subset"
    assert res["status"] == "skipped"
    assert res["passed"] is False
    assert "CHEMBENCH_DATASET_PATH" in res["reason"]


def test_dataset_present_but_live_scoring_disabled_returns_skipped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Defensive: make sure we don't accidentally pick up a real env var.
    monkeypatch.delenv("CHEMBENCH_LIVE_SCORING", raising=False)
    p = _write_jsonl(tmp_path, [
        {"question": "q1", "expected_answer": "a1"},
        {"question": "q2", "expected_answer": "a2"},
    ])
    res = eval_chembench_subset.run(dataset_path=str(p))
    assert res["status"] == "skipped"
    assert res["passed"] is False
    assert res["metrics"]["n_questions_loaded"] == 2
    assert "live scoring disabled" in res["reason"]


def test_live_scoring_passes_when_above_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CHEMBENCH_LIVE_SCORING", "true")
    p = _write_jsonl(tmp_path, [
        {"question": "What is the answer?", "expected_answer": "Forty-Two"},
        {"question": "And again?", "expected_answer": "Forty-Two"},
    ])

    # Mock httpx.Client so we don't need a real agent
    class _StubResp:
        def raise_for_status(self) -> None:
            pass

        def json(self) -> dict[str, str]:
            # Both questions get a passing answer (case-insensitive substring
            # of the expected_answer).
            return {"text": "The final answer is forty-two."}

    class _StubClient:
        def __enter__(self) -> "_StubClient":
            return self

        def __exit__(self, *_: object) -> None:
            pass

        def post(self, *_args: object, **_kwargs: object) -> _StubResp:
            return _StubResp()

    monkeypatch.setattr(httpx, "Client", _StubClient)

    res = eval_chembench_subset.run(dataset_path=str(p), target_pass_rate=0.5)
    assert res["passed"] is True
    assert res["status"] == "ok"
    assert res["metrics"]["n_questions"] == 2
    assert res["metrics"]["n_correct"] == 2
    assert res["metrics"]["pass_rate"] == 1.0


def test_live_scoring_below_target_returns_below_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CHEMBENCH_LIVE_SCORING", "true")
    p = _write_jsonl(tmp_path, [
        {"question": "q1", "expected_answer": "right-answer"},
        {"question": "q2", "expected_answer": "right-answer"},
    ])

    class _StubResp:
        def raise_for_status(self) -> None:
            pass

        def json(self) -> dict[str, str]:
            return {"text": "wrong"}

    class _StubClient:
        def __enter__(self) -> "_StubClient":
            return self

        def __exit__(self, *_: object) -> None:
            pass

        def post(self, *_args: object, **_kwargs: object) -> _StubResp:
            return _StubResp()

    monkeypatch.setattr(httpx, "Client", _StubClient)

    res = eval_chembench_subset.run(dataset_path=str(p), target_pass_rate=0.5)
    assert res["passed"] is False
    assert res["status"] == "below_target"
    assert res["metrics"]["pass_rate"] == 0.0


def test_live_scoring_treats_http_errors_as_n_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CHEMBENCH_LIVE_SCORING", "true")
    p = _write_jsonl(tmp_path, [
        {"question": "q1", "expected_answer": "a1"},
        {"question": "q2", "expected_answer": "a2"},
    ])

    class _StubClient:
        def __enter__(self) -> "_StubClient":
            return self

        def __exit__(self, *_: object) -> None:
            pass

        def post(self, *_args: object, **_kwargs: object):
            raise httpx.ConnectError("agent unreachable")

    monkeypatch.setattr(httpx, "Client", _StubClient)

    res = eval_chembench_subset.run(dataset_path=str(p))
    # Both questions errored; 0 correct out of 2 → below target.
    assert res["passed"] is False
    assert res["metrics"]["n_errors"] == 2
    assert res["metrics"]["n_correct"] == 0


def test_live_scoring_skips_malformed_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Rows missing question/expected_answer increment n_errors but don't
    # crash the run. The questions count for the rate (denominator) is
    # the loaded total, including malformed rows; n_correct is bounded
    # to well-formed scored rows.
    monkeypatch.setenv("CHEMBENCH_LIVE_SCORING", "true")
    p = _write_jsonl(tmp_path, [
        {"question": "q1", "expected_answer": "match"},
        {"question": None, "expected_answer": None},  # malformed
    ])

    class _StubResp:
        def raise_for_status(self) -> None:
            pass

        def json(self) -> dict[str, str]:
            return {"text": "match"}

    class _StubClient:
        def __enter__(self) -> "_StubClient":
            return self

        def __exit__(self, *_: object) -> None:
            pass

        def post(self, *_args: object, **_kwargs: object) -> _StubResp:
            return _StubResp()

    monkeypatch.setattr(httpx, "Client", _StubClient)

    res = eval_chembench_subset.run(dataset_path=str(p), target_pass_rate=0.4)
    assert res["metrics"]["n_correct"] == 1
    assert res["metrics"]["n_errors"] == 1
    assert res["metrics"]["pass_rate"] == 0.5
    assert res["passed"] is True
