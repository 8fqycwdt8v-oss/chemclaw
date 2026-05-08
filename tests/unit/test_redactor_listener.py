"""Tests for services.litellm_redactor.listener.

The listener LISTENs on the `redaction_patterns_changed` channel and
calls `DynamicPatternLoader.invalidate()` on every NOTIFY. Tests stub
psycopg via AsyncMock so the listener can be exercised without a real
Postgres + LISTEN/NOTIFY round-trip.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.litellm_redactor.dynamic_patterns import DynamicPatternLoader
from services.litellm_redactor.listener import run_listener


def _make_notify(channel: str, payload: str) -> Any:
    n = MagicMock()
    n.channel = channel
    n.payload = payload
    return n


def _make_async_conn(notifies: list[Any]) -> Any:
    """Mock psycopg.AsyncConnection that yields the given NOTIFY frames
    via `conn.notifies()` then raises StopAsyncIteration.
    """
    cursor = MagicMock()
    cursor.execute = AsyncMock(return_value=None)
    cursor.__aenter__ = AsyncMock(return_value=cursor)
    cursor.__aexit__ = AsyncMock(return_value=None)

    async def fake_notifies():
        for n in notifies:
            yield n

    conn = MagicMock()
    conn.cursor = MagicMock(return_value=cursor)
    conn.notifies = MagicMock(return_value=fake_notifies())
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=None)
    return conn


@pytest.mark.asyncio
async def test_listener_invalidates_on_notify():
    loader = DynamicPatternLoader(dsn="dummy")
    # Pre-populate the cache so we can verify invalidate() resets it.
    loader._cache_at = 12345.0  # type: ignore[attr-defined]

    fake_conn = _make_async_conn(
        [_make_notify("redaction_patterns_changed", "global:")],
    )

    with patch(
        "services.litellm_redactor.listener.psycopg.AsyncConnection.connect",
        new=AsyncMock(return_value=fake_conn),
    ):
        shutdown = asyncio.Event()
        # Run the listener until the single notify is consumed; signal
        # shutdown right after to break the loop.
        async def _kicker():
            await asyncio.sleep(0.05)
            shutdown.set()

        await asyncio.gather(
            run_listener(loader, dsn="dummy", shutdown_event=shutdown),
            _kicker(),
        )

    # invalidate() resets _cache_at to 0.0.
    assert loader._cache_at == 0.0  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_listener_initial_invalidate_runs():
    """When the listener establishes a connection it invalidates eagerly
    so any changes that landed during reconnect-backoff are picked up
    rather than waiting on the next NOTIFY."""
    loader = DynamicPatternLoader(dsn="dummy")
    loader._cache_at = 99999.0  # type: ignore[attr-defined]

    fake_conn = _make_async_conn([])  # no notifies — we exit on shutdown

    shutdown = asyncio.Event()

    async def _kicker():
        # Let the outer while pass + connect happen + eager invalidate run.
        await asyncio.sleep(0.05)
        shutdown.set()

    with patch(
        "services.litellm_redactor.listener.psycopg.AsyncConnection.connect",
        new=AsyncMock(return_value=fake_conn),
    ):
        await asyncio.gather(
            run_listener(loader, dsn="dummy", shutdown_event=shutdown),
            _kicker(),
        )

    assert loader._cache_at == 0.0  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_listener_reconnects_on_operational_error():
    """A psycopg.OperationalError during the inner loop must not crash
    the outer reconnect loop. The shutdown event is the only clean exit."""
    import psycopg

    loader = DynamicPatternLoader(dsn="dummy")
    call_count = {"n": 0}

    async def flaky_connect(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise psycopg.OperationalError("transient blip")
        # Second call: return a conn that exits cleanly.
        return _make_async_conn([])

    shutdown = asyncio.Event()

    async def _kicker():
        # Wait for the first reconnect attempt, then shutdown.
        await asyncio.sleep(0.05)
        shutdown.set()

    with patch(
        "services.litellm_redactor.listener.psycopg.AsyncConnection.connect",
        new=AsyncMock(side_effect=flaky_connect),
    ), patch(
        "services.litellm_redactor.listener._BACKOFF_INITIAL", 0.01,
    ):
        await asyncio.gather(
            run_listener(loader, dsn="dummy", shutdown_event=shutdown),
            _kicker(),
        )

    # At least one reconnect happened.
    assert call_count["n"] >= 2
