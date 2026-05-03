"""Synchronous workflow engine for multi-step xtb / crest pipelines.

Composes the existing subprocess primitives into named recipes (see the
``recipes/`` package). Each recipe is a tuple of typed steps with a
per-step timeout; the engine records start / finish timing, captures
errors, and runs the whole sequence inside one ``TemporaryDirectory``
so step-to-step artifacts are cleaned up automatically.

The engine is intentionally synchronous (request / response). Long-
running async execution via the A-on-C event-sourced pattern is
documented as a follow-up in the plan file but explicitly out of scope.
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
import time
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

log = logging.getLogger("mcp-xtb.workflow")

T = TypeVar("T")
U = TypeVar("U")


# ---------------------------------------------------------------------------
# Subprocess primitive — async wrapper used by every recipe step.
# Tests mock at this boundary.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SubprocessResult:
    returncode: int
    stdout: str
    stderr: str


async def run_subprocess(args: list[str], cwd: Path, timeout_s: int) -> SubprocessResult:
    """Run a binary with shell=False and a hard timeout.

    On timeout the process is killed and ``asyncio.TimeoutError`` is
    raised. The engine catches that and converts it to a step failure.
    """
    proc = await asyncio.create_subprocess_exec(
        *args,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout_b, stderr_b = await asyncio.wait_for(
            proc.communicate(), timeout=timeout_s,
        )
    except asyncio.TimeoutError:
        proc.kill()
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            pass
        raise
    return SubprocessResult(
        returncode=proc.returncode if proc.returncode is not None else -1,
        stdout=stdout_b.decode(errors="replace"),
        stderr=stderr_b.decode(errors="replace"),
    )


# ---------------------------------------------------------------------------
# parallel_map — bounded concurrency for fan-out steps.
# Lifted from the ad-hoc ``Semaphore(4)`` block in mcp_synthegy_mech.xtb_validator;
# that file should migrate onto this helper in a follow-up.
#
# Uses TaskGroup so the first sibling failure cancels the rest — important
# for multi-conformer optimisations where a single bad geometry shouldn't
# burn another 10× wall-clock waiting for the remaining xtb runs.
# ---------------------------------------------------------------------------

async def parallel_map(
    items: Iterable[T],
    fn: Callable[[T], Awaitable[U]],
    max_concurrency: int,
) -> list[U]:
    if max_concurrency < 1:
        raise ValueError("max_concurrency must be >= 1")
    items_list = list(items)
    if not items_list:
        return []
    sem = asyncio.Semaphore(max_concurrency)
    results: list[U] = [None] * len(items_list)  # type: ignore[list-item]

    async def _bounded(idx: int, item: T) -> None:
        async with sem:
            results[idx] = await fn(item)

    try:
        async with asyncio.TaskGroup() as tg:
            for i, item in enumerate(items_list):
                tg.create_task(_bounded(i, item))
    except* Exception as eg:
        # TaskGroup wraps everything in an ExceptionGroup; the engine layer
        # only knows how to render one error per step, so unwrap to the
        # first exception (the one that triggered the cancellation).
        raise eg.exceptions[0] from None
    return results


# ---------------------------------------------------------------------------
# Engine types
# ---------------------------------------------------------------------------

@dataclass
class Ctx:
    """State threaded through a recipe execution."""

    workdir: Path
    inputs: dict[str, Any]
    artifacts: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    step_timeout_s: int = 120


@dataclass(frozen=True)
class Step:
    name: str
    fn: Callable[[Ctx], Awaitable[Any]]
    timeout_s: int | None = None  # None → use Ctx.step_timeout_s
    optional: bool = False


@dataclass(frozen=True)
class Workflow:
    name: str
    steps: tuple[Step, ...]
    output: Callable[[Ctx], dict[str, Any]]
    # Pydantic model the recipe uses to validate inputs up-front. The
    # /run_workflow handler calls ``inputs_schema(**req.inputs)`` before
    # calling ``run`` so a typo in a key name fails at the request edge
    # with a structured 400 instead of as a step-level engine failure.
    # Optional for backward-compat with engine-only callers; production
    # recipes should always set it.
    inputs_schema: type[BaseModel] | None = None


class StepReport(BaseModel):
    name: str
    seconds: float
    ok: bool
    error: str | None = None


class WorkflowResult(BaseModel):
    recipe: str
    success: bool
    steps: list[StepReport]
    outputs: dict[str, Any]
    warnings: list[str]
    total_seconds: float


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

async def run(
    wf: Workflow,
    inputs: dict[str, Any],
    *,
    total_timeout_s: int,
    step_timeout_s: int = 120,
) -> WorkflowResult:
    """Execute a recipe and return a structured report.

    Never raises for step-level failures: success / failure is encoded in
    the ``success`` field. Programmer errors (bad recipe shape) still
    raise.
    """
    started = time.monotonic()
    deadline = started + total_timeout_s
    reports: list[StepReport] = []
    failed = False

    # Validate inputs up-front against the recipe's schema (if set) so
    # typos surface as a structured failure with field-level detail
    # instead of as an in-step KeyError. This synthetic step is reported
    # back so the caller sees timing for it like any other.
    validated_inputs: dict[str, Any] = dict(inputs)
    if wf.inputs_schema is not None:
        t0 = time.monotonic()
        try:
            validated_inputs = wf.inputs_schema.model_validate(inputs).model_dump()
            reports.append(
                StepReport(
                    name="validate_inputs",
                    seconds=time.monotonic() - t0,
                    ok=True,
                ),
            )
        except ValidationError as exc:
            reports.append(
                StepReport(
                    name="validate_inputs",
                    seconds=time.monotonic() - t0,
                    ok=False,
                    error=f"input validation failed: {exc.errors()}",
                ),
            )
            failed = True

    with tempfile.TemporaryDirectory() as tmp:
        ctx = Ctx(
            workdir=Path(tmp),
            inputs=validated_inputs,
            step_timeout_s=step_timeout_s,
        )
        for step in wf.steps:
            if failed:
                break
            t0 = time.monotonic()
            remaining_total = deadline - t0
            if remaining_total <= 0:
                _record(reports, step, t0, "workflow total_timeout exceeded")
                if step.optional:
                    ctx.warnings.append(f"{step.name}: skipped (total timeout)")
                    continue
                failed = True
                continue

            step_cap = float(
                step.timeout_s if step.timeout_s is not None else ctx.step_timeout_s
            )
            cap = min(step_cap, remaining_total)
            try:
                value = await asyncio.wait_for(step.fn(ctx), timeout=cap)
                ctx.artifacts[step.name] = value
                reports.append(
                    StepReport(
                        name=step.name,
                        seconds=time.monotonic() - t0,
                        ok=True,
                    ),
                )
            except asyncio.TimeoutError:
                _record(reports, step, t0, f"step timed out after {cap:.2f}s")
                if step.optional:
                    ctx.warnings.append(f"{step.name}: timeout")
                else:
                    failed = True
            except Exception as exc:  # noqa: BLE001 — engine boundary
                _record(reports, step, t0, f"{type(exc).__name__}: {exc}")
                if step.optional:
                    ctx.warnings.append(f"{step.name}: {exc}")
                else:
                    failed = True

        outputs: dict[str, Any] = {} if failed else wf.output(ctx)
        result = WorkflowResult(
            recipe=wf.name,
            success=not failed,
            steps=reports,
            outputs=outputs,
            warnings=list(ctx.warnings),
            total_seconds=time.monotonic() - started,
        )
        log.info(
            "workflow_complete recipe=%s success=%s total_seconds=%.3f n_steps=%d n_warnings=%d",
            result.recipe,
            result.success,
            result.total_seconds,
            len(result.steps),
            len(result.warnings),
        )
        return result


def _record(reports: list[StepReport], step: Step, t0: float, error: str) -> None:
    reports.append(
        StepReport(
            name=step.name,
            seconds=time.monotonic() - t0,
            ok=False,
            error=error,
        ),
    )
