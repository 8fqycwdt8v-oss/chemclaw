"""Unit tests for the new workflow_engine step kinds — conditional,
parallel, and sub_agent. All run via _execute_step / direct dispatch
without DB or agent-claw, mocking the HTTP client where needed.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from services.workflow_engine.main import EngineSettings, WorkflowEngine


def _build_engine() -> WorkflowEngine:
    return WorkflowEngine(EngineSettings())


# ---------------------------------------------------------------------------
# conditional
# ---------------------------------------------------------------------------


def test_conditional_then_branch_taken_when_truthy():
    eng = _build_engine()
    scope = {"input": {"score": 0.9}}
    step = {
        "kind": "conditional",
        "if": "input.score > `0.5`",
        "then": {"kind": "tool_call", "tool": "fake"},
        "else": {"kind": "tool_call", "tool": "other"},
    }

    captured: list[str] = []

    async def fake_exec(s: dict[str, Any], _scope: dict[str, Any]) -> Any:
        captured.append(s["tool"])
        return {"called": s["tool"]}

    eng._exec_tool_call = fake_exec  # type: ignore[assignment]

    result = asyncio.run(eng._execute_step(step, scope))
    assert captured == ["fake"]
    assert result == {"branch": "then", "result": {"called": "fake"}}


def test_conditional_else_branch_taken_when_falsy():
    eng = _build_engine()
    scope = {"input": {"score": 0.1}}
    step = {
        "kind": "conditional",
        "if": "input.score > `0.5`",
        "then": {"kind": "tool_call", "tool": "fake"},
        "else": {"kind": "tool_call", "tool": "other"},
    }

    captured: list[str] = []

    async def fake_exec(s: dict[str, Any], _scope: dict[str, Any]) -> Any:
        captured.append(s["tool"])
        return {"called": s["tool"]}

    eng._exec_tool_call = fake_exec  # type: ignore[assignment]

    result = asyncio.run(eng._execute_step(step, scope))
    assert captured == ["other"]
    assert result == {"branch": "else", "result": {"called": "other"}}


def test_conditional_else_absent_returns_none():
    eng = _build_engine()
    step = {"kind": "conditional", "if": "missing.field", "then": {"kind": "tool_call", "tool": "x"}}
    result = asyncio.run(eng._execute_step(step, {}))
    assert result == {"branch": "else", "result": None}


def test_conditional_requires_if_string():
    eng = _build_engine()
    with pytest.raises(ValueError, match="non-empty 'if'"):
        asyncio.run(eng._execute_step({"kind": "conditional"}, {}))


def test_conditional_then_must_be_dict():
    eng = _build_engine()
    step = {"kind": "conditional", "if": "@", "then": "not-a-dict"}
    with pytest.raises(ValueError, match="must be a step dict"):
        asyncio.run(eng._execute_step(step, {"value": True}))


# ---------------------------------------------------------------------------
# parallel
# ---------------------------------------------------------------------------


def test_parallel_runs_all_substeps_and_returns_results_in_order():
    eng = _build_engine()
    step = {
        "kind": "parallel",
        "steps": [
            {"kind": "tool_call", "tool": "a"},
            {"kind": "tool_call", "tool": "b"},
            {"kind": "tool_call", "tool": "c"},
        ],
    }

    async def fake_exec(s: dict[str, Any], _scope: dict[str, Any]) -> Any:
        # Simulate async I/O so the gather actually overlaps.
        await asyncio.sleep(0)
        return {"tool": s["tool"]}

    eng._exec_tool_call = fake_exec  # type: ignore[assignment]

    result = asyncio.run(eng._execute_step(step, {}))
    assert result == [{"tool": "a"}, {"tool": "b"}, {"tool": "c"}]


def test_parallel_propagates_substep_failure():
    eng = _build_engine()
    step = {
        "kind": "parallel",
        "steps": [
            {"kind": "tool_call", "tool": "a"},
            {"kind": "tool_call", "tool": "boom"},
        ],
    }

    async def fake_exec(s: dict[str, Any], _scope: dict[str, Any]) -> Any:
        if s["tool"] == "boom":
            raise RuntimeError("substep failed")
        return {"tool": s["tool"]}

    eng._exec_tool_call = fake_exec  # type: ignore[assignment]

    with pytest.raises(RuntimeError, match="substep failed"):
        asyncio.run(eng._execute_step(step, {}))


def test_parallel_max_concurrency_cap_is_respected():
    eng = _build_engine()
    step = {
        "kind": "parallel",
        "max_concurrency": 2,
        "steps": [{"kind": "tool_call", "tool": str(i)} for i in range(5)],
    }

    in_flight = 0
    peak = 0

    async def fake_exec(s: dict[str, Any], _scope: dict[str, Any]) -> Any:
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.01)
        in_flight -= 1
        return {"tool": s["tool"]}

    eng._exec_tool_call = fake_exec  # type: ignore[assignment]

    result = asyncio.run(eng._execute_step(step, {}))
    assert len(result) == 5
    assert peak <= 2, f"max_concurrency=2 violated, peak observed {peak}"


def test_parallel_requires_non_empty_steps():
    eng = _build_engine()
    with pytest.raises(ValueError, match="non-empty 'steps'"):
        asyncio.run(eng._execute_step({"kind": "parallel", "steps": []}, {}))


def test_parallel_substeps_must_be_dicts():
    eng = _build_engine()
    step = {"kind": "parallel", "steps": [{"kind": "tool_call", "tool": "a"}, "string"]}
    with pytest.raises(ValueError, match="must be a step dict"):
        asyncio.run(eng._execute_step(step, {}))


# ---------------------------------------------------------------------------
# sub_agent
# ---------------------------------------------------------------------------


def test_sub_agent_requires_goal_and_user():
    eng = _build_engine()
    with pytest.raises(ValueError, match="non-empty 'goal'"):
        asyncio.run(eng._execute_step({"kind": "sub_agent"}, {}))
    with pytest.raises(ValueError, match="user_entra_id"):
        asyncio.run(eng._execute_step({"kind": "sub_agent", "goal": "hi"}, {}))


def test_sub_agent_validates_type():
    eng = _build_engine()
    eng._http = AsyncMock()
    step = {
        "kind": "sub_agent",
        "goal": "hi",
        "user_entra_id": "user-1",
        "type": "wizard",
    }
    with pytest.raises(ValueError, match="type"):
        asyncio.run(eng._execute_step(step, {}))


def test_sub_agent_resolves_goal_jmespath_template():
    eng = _build_engine()
    response = MagicMock(status_code=200, json=lambda: {"text": "ok"})
    captured: dict[str, Any] = {}

    async def fake_post(url, **kwargs):  # noqa: ANN001
        captured["url"] = url
        captured["json"] = kwargs.get("json")
        captured["headers"] = kwargs.get("headers", {})
        return response

    eng._http = MagicMock()
    eng._http.post = fake_post

    scope = {"steps": {"first": {"text": "synthesise X"}}}
    step = {
        "kind": "sub_agent",
        "goal": "${steps.first.text}",
        "user_entra_id": "user-1",
        "type": "chemist",
    }

    # Dev-mode token path (no signing key) — sends x-user-entra-id header.
    old_key = os.environ.pop("MCP_AUTH_SIGNING_KEY", None)
    try:
        result = asyncio.run(eng._execute_step(step, scope))
    finally:
        if old_key is not None:
            os.environ["MCP_AUTH_SIGNING_KEY"] = old_key

    assert result == {"text": "ok"}
    assert captured["json"]["goal"] == "synthesise X"
    assert captured["json"]["user_entra_id"] == "user-1"
    assert captured["json"]["type"] == "chemist"
    assert captured["headers"].get("x-user-entra-id") == "user-1"


def test_sub_agent_translates_4xx_to_runtime_error():
    eng = _build_engine()
    response = MagicMock(status_code=403, text="forbidden")

    async def fake_post(url, **kwargs):  # noqa: ANN001, ARG001
        return response

    eng._http = MagicMock()
    eng._http.post = fake_post

    step = {"kind": "sub_agent", "goal": "x", "user_entra_id": "u"}
    old_key = os.environ.pop("MCP_AUTH_SIGNING_KEY", None)
    try:
        with pytest.raises(RuntimeError, match="403"):
            asyncio.run(eng._execute_step(step, {}))
    finally:
        if old_key is not None:
            os.environ["MCP_AUTH_SIGNING_KEY"] = old_key


def test_sub_agent_translates_timeout_to_timeout_error():
    eng = _build_engine()

    async def fake_post(url, **kwargs):  # noqa: ANN001, ARG001
        raise httpx.TimeoutException("slow")

    eng._http = MagicMock()
    eng._http.post = fake_post

    step = {
        "kind": "sub_agent",
        "goal": "x",
        "user_entra_id": "u",
        "timeout_seconds": 1,
    }
    old_key = os.environ.pop("MCP_AUTH_SIGNING_KEY", None)
    try:
        with pytest.raises(TimeoutError, match="1s"):
            asyncio.run(eng._execute_step(step, {}))
    finally:
        if old_key is not None:
            os.environ["MCP_AUTH_SIGNING_KEY"] = old_key


# ---------------------------------------------------------------------------
# loop kind still NotImplementedError
# ---------------------------------------------------------------------------


def test_loop_kind_still_raises_not_implemented():
    eng = _build_engine()
    with pytest.raises(NotImplementedError, match="loop"):
        asyncio.run(eng._execute_step({"kind": "loop"}, {}))
