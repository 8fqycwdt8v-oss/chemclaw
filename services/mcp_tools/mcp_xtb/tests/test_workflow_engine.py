"""Engine semantics: ordering, per-step timeout, total timeout, optional steps,
warning aggregation, success/failure encoding.

Pure stub steps — no subprocess, no rdkit. Runs without xtb installed.
"""
from __future__ import annotations

import asyncio

import pytest

from services.mcp_tools.mcp_xtb.workflow import (
    Ctx,
    Step,
    Workflow,
    parallel_map,
    run,
)


def _step(name: str, value=None, *, raises=None, sleep_s: float = 0.0,
          timeout_s: int | None = None, optional: bool = False) -> Step:
    async def _fn(ctx: Ctx):
        if sleep_s:
            await asyncio.sleep(sleep_s)
        if raises is not None:
            raise raises
        return value if value is not None else name

    return Step(name=name, fn=_fn, timeout_s=timeout_s, optional=optional)


def _wf(*steps: Step, output=None) -> Workflow:
    return Workflow(
        name="t",
        steps=tuple(steps),
        output=output or (lambda c: dict(c.artifacts)),
    )


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------

async def test_steps_run_in_order_and_artifacts_chain():
    async def _read_prior(ctx: Ctx):
        return f"prior={ctx.artifacts['a']}"

    wf = _wf(
        _step("a", value=1),
        Step(name="b", fn=_read_prior),
    )
    res = await run(wf, {}, total_timeout_s=10)
    assert res.success
    assert [s.name for s in res.steps] == ["a", "b"]
    assert all(s.ok for s in res.steps)
    assert res.outputs == {"a": 1, "b": "prior=1"}


async def test_each_step_has_recorded_timing():
    res = await run(_wf(_step("a", sleep_s=0.01)), {}, total_timeout_s=5)
    assert res.success
    assert res.steps[0].seconds >= 0.01
    assert res.total_seconds >= res.steps[0].seconds


async def test_inputs_are_visible_to_steps_and_isolated_from_caller():
    """Step sees inputs and can read them; mutating ctx.inputs does not
    leak back to caller's dict (we copy on entry)."""
    async def _peek(ctx: Ctx):
        ctx.inputs["sneaky"] = "nope"
        return ctx.inputs.get("smiles")

    caller_inputs = {"smiles": "CCO"}
    res = await run(_wf(Step(name="peek", fn=_peek)), caller_inputs, total_timeout_s=5)
    assert res.success
    assert res.outputs == {"peek": "CCO"}
    assert "sneaky" not in caller_inputs


# ---------------------------------------------------------------------------
# Failure handling
# ---------------------------------------------------------------------------

async def test_required_step_failure_marks_run_failed_and_short_circuits():
    wf = _wf(
        _step("a"),
        _step("boom", raises=ValueError("nope")),
        _step("never"),
    )
    res = await run(wf, {}, total_timeout_s=5)
    assert not res.success
    assert [s.name for s in res.steps] == ["a", "boom"]
    assert res.outputs == {}
    boom = res.steps[1]
    assert not boom.ok
    assert "ValueError" in (boom.error or "")
    assert "nope" in (boom.error or "")


async def test_optional_step_failure_continues_and_records_warning():
    wf = _wf(
        _step("opt", raises=RuntimeError("oops"), optional=True),
        _step("after", value=42),
    )
    res = await run(wf, {}, total_timeout_s=5)
    assert res.success
    assert res.outputs == {"after": 42}
    assert any("oops" in w for w in res.warnings)


# ---------------------------------------------------------------------------
# Timeouts
# ---------------------------------------------------------------------------

async def test_per_step_timeout_fires_when_step_exceeds_cap():
    async def _slow(ctx: Ctx):
        await asyncio.sleep(2.0)

    wf = Workflow(
        name="t",
        steps=(Step(name="slow", fn=_slow, timeout_s=1),),
        output=lambda c: {},
    )
    res = await run(wf, {}, total_timeout_s=10, step_timeout_s=120)
    assert not res.success
    assert "timed out" in (res.steps[0].error or "")


async def test_optional_step_timeout_records_warning_and_continues():
    async def _slow(ctx: Ctx):
        await asyncio.sleep(2.0)

    wf = Workflow(
        name="t",
        steps=(
            Step(name="slow", fn=_slow, timeout_s=1, optional=True),
            Step(name="after", fn=(lambda c: _ok())),
        ),
        output=lambda c: dict(c.artifacts),
    )
    res = await run(wf, {}, total_timeout_s=10, step_timeout_s=120)
    assert res.success
    assert any("timeout" in w.lower() for w in res.warnings)
    assert res.outputs == {"after": "ok"}


async def _ok():
    return "ok"


async def test_total_timeout_short_circuits_remaining_steps():
    async def _sleep(ctx):
        await asyncio.sleep(0.4)

    wf = Workflow(
        name="t",
        steps=(
            Step(name="a", fn=_sleep),
            Step(name="b", fn=_sleep),
            Step(name="c", fn=_sleep),
        ),
        output=lambda c: dict(c.artifacts),
    )
    res = await run(wf, {}, total_timeout_s=1, step_timeout_s=120)
    assert not res.success
    assert res.steps[0].ok
    assert res.total_seconds < 1.6


# ---------------------------------------------------------------------------
# parallel_map
# ---------------------------------------------------------------------------

async def test_parallel_map_respects_max_concurrency():
    in_flight = 0
    peak = 0
    lock = asyncio.Lock()

    async def _fn(i: int) -> int:
        nonlocal in_flight, peak
        async with lock:
            in_flight += 1
            peak = max(peak, in_flight)
        await asyncio.sleep(0.05)
        async with lock:
            in_flight -= 1
        return i * 2

    out = await parallel_map(range(10), _fn, max_concurrency=3)
    assert out == [i * 2 for i in range(10)]
    assert peak <= 3


async def test_parallel_map_rejects_zero_concurrency():
    async def _noop(_: int):
        return None

    with pytest.raises(ValueError):
        await parallel_map([1, 2], _noop, max_concurrency=0)
