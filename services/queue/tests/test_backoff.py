"""PR #87 introduced exponential retry backoff in QueueWorker._maybe_retry:

    backoff_seconds = min(30 * (2 ** (attempts - 1)), 3600)

The full method is gated behind a `# pragma: no cover` because end-to-end
exercise needs a real Postgres (BACKLOG'd as a testcontainer round-trip).
The arithmetic invariant itself, however, is the load-bearing piece — get
that wrong and a transiently-failing task either hammers the upstream
(0s backoff) or gets stuck for hours (overflow).

This file pins the formula directly so a future refactor that swaps in a
new schedule has to either match these numbers or update this test
explicitly.
"""
from __future__ import annotations

import pytest


def _backoff_seconds(attempts: int) -> int:
    """Mirror of the formula in services/queue/worker.py::_maybe_retry.

    `attempts` here is post-increment (matches `_lease_one`'s
    `attempts = attempts + 1`), so the first retry attempt is 1.
    """
    return min(30 * (2 ** (attempts - 1)), 3600)


@pytest.mark.parametrize(
    "attempts, expected",
    [
        (1, 30),       # 30 * 2^0
        (2, 60),       # 30 * 2^1
        (3, 120),      # 30 * 2^2
        (4, 240),      # 30 * 2^3
        (5, 480),
        (6, 960),
        (7, 1920),
        (8, 3600),     # 30 * 2^7 = 3840 — clamped to 3600
        (9, 3600),     # always clamped after the cap
        (20, 3600),    # large values must not overflow / wrap
        (100, 3600),
    ],
)
def test_backoff_schedule(attempts: int, expected: int) -> None:
    assert _backoff_seconds(attempts) == expected


def test_backoff_is_strictly_monotonic_until_clamp() -> None:
    """First few retries must be strictly increasing — a flat schedule
    would let a poison message hammer the upstream service every 30s."""
    from itertools import pairwise

    series = [_backoff_seconds(a) for a in range(1, 8)]
    for prev, nxt in pairwise(series):
        assert nxt > prev, f"backoff regressed: {series}"


def test_backoff_never_exceeds_one_hour() -> None:
    """The cap is the operational invariant: retries must keep happening
    on a sane cadence — no gigantic gaps that look like the queue is
    wedged. Crank `attempts` up to absurd values to make sure the
    `min(...)` clamp is the only thing standing between us and overflow."""
    for attempts in range(1, 1000):
        assert _backoff_seconds(attempts) <= 3600


def test_first_retry_is_thirty_seconds() -> None:
    """attempts=1 (the first retry, after _lease_one bumped the counter
    from 0) must be exactly 30 seconds. Off-by-one on the exponent is the
    most likely refactor accident — pin it explicitly."""
    assert _backoff_seconds(1) == 30


def test_backoff_matches_worker_module_formula() -> None:
    """Final guard: re-import the worker module's literal expression so
    any drift between the test mirror and production code is caught."""
    import inspect

    from services.queue import worker

    src = inspect.getsource(worker.QueueWorker._maybe_retry)
    # The exact expression is what we mirror above; if someone rewrites
    # _maybe_retry to use a different formula, this assertion forces them
    # to also update this test (or convert it into a real testcontainer
    # round-trip).
    assert "min(30 * (2 ** (row[\"attempts\"] - 1)), 3600)" in src, (
        "Backoff formula in QueueWorker._maybe_retry diverged from "
        "test_backoff.py mirror — update both or replace with the "
        "deferred testcontainer test (BACKLOG)."
    )
