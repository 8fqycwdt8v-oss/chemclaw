"""Postgres LISTEN'er for redaction_patterns_changed.

Wires an asyncio task that LISTENs on the `redaction_patterns_changed`
channel (from db/init/50_redaction_patterns_notify.sql) and calls
`DynamicPatternLoader.invalidate()` on every NOTIFY so admin
POST/PATCH/DELETE on redaction_patterns propagates to the in-process
cache immediately rather than waiting on the 5s TTL.

Architecture
============
The listener is OPT-IN. The litellm container ships commented out in
docker-compose.yml; when an operator uncomments it, they spawn this
listener as a background asyncio task during litellm startup. The
TTL fallback in `DynamicPatternLoader.get_patterns` is the operational
safety net for the case where the listener is offline (DB blip,
container restart) — the trigger fires NOTIFY async-best-effort and
the next post-TTL refresh catches dropped events.

Usage
-----
    import asyncio
    from services.litellm_redactor.listener import run_listener
    from services.litellm_redactor.dynamic_patterns import get_loader

    asyncio.create_task(run_listener(get_loader(), dsn=os.environ["REDACTOR_PG_DSN"]))

The task runs until cancellation or persistent DB failure. On any
psycopg.OperationalError it reconnects with exponential backoff (mirroring
BaseProjector) so transient blips don't lose the listener until next
container restart.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import psycopg

from services.litellm_redactor.dynamic_patterns import DynamicPatternLoader

log = logging.getLogger("litellm.redactor.listener")

_BACKOFF_INITIAL = 1.0
_BACKOFF_MAX = 30.0


async def run_listener(
    loader: DynamicPatternLoader,
    dsn: str,
    *,
    shutdown_event: asyncio.Event | None = None,
) -> None:
    """Run the LISTEN loop until cancellation / shutdown.

    Args:
      loader: the DynamicPatternLoader instance to invalidate on each NOTIFY.
      dsn: Postgres DSN. Must connect as a role that can LISTEN
        (`chemclaw_app` / `chemclaw_service` both fine).
      shutdown_event: optional asyncio.Event — when set, the listener
        exits cleanly after the next NOTIFY or 5s timeout.
    """
    backoff = _BACKOFF_INITIAL
    while shutdown_event is None or not shutdown_event.is_set():
        try:
            await _connect_and_listen(loader, dsn, shutdown_event)
            # Clean exit (shutdown event set inside the inner loop).
            break
        except (psycopg.OperationalError, OSError) as exc:
            if shutdown_event is not None and shutdown_event.is_set():
                break
            log.warning(
                "redactor listener DB error: %s — reconnecting in %.1fs",
                exc,
                backoff,
            )
            try:
                if shutdown_event is not None:
                    await asyncio.wait_for(
                        shutdown_event.wait(), timeout=backoff,
                    )
                    break
                else:
                    await asyncio.sleep(backoff)
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 2, _BACKOFF_MAX)


async def _connect_and_listen(
    loader: DynamicPatternLoader,
    dsn: str,
    shutdown_event: asyncio.Event | None,
) -> None:
    async with await psycopg.AsyncConnection.connect(
        dsn, autocommit=True,
    ) as conn:
        async with conn.cursor() as cur:
            await cur.execute("LISTEN redaction_patterns_changed")
        log.info("redactor listener LISTENING on redaction_patterns_changed")

        # Best-effort initial invalidate so we pick up any changes that
        # landed during reconnect backoff.
        loader.invalidate()

        notify_gen = conn.notifies()
        while shutdown_event is None or not shutdown_event.is_set():
            try:
                # await with a timeout so the shutdown event gets checked
                # periodically even on a quiet channel.
                notify = await asyncio.wait_for(
                    notify_gen.__anext__(), timeout=5.0,
                )
            except asyncio.TimeoutError:
                continue
            except StopAsyncIteration:
                break
            log.info(
                "redactor cache invalidate (channel=%s payload=%s)",
                notify.channel,
                notify.payload,
            )
            loader.invalidate()


def start_background_listener(
    loader: DynamicPatternLoader,
    dsn: str,
) -> tuple[asyncio.Task[None], asyncio.Event]:
    """Convenience wrapper — spawn the listener as a background task.

    Returns the task handle and a shutdown event. Caller is expected to
    keep a reference to the task (asyncio garbage-collects loose
    create_task() returns) and to set the event on container shutdown.
    """
    shutdown = asyncio.Event()
    task = asyncio.create_task(
        run_listener(loader, dsn, shutdown_event=shutdown)
    )
    # Stamp the task name so dashboards / debug output can find it.
    try:
        task.set_name("redactor-invalidate-listener")
    except Exception:  # pragma: no cover — defensive against runtime stub
        pass
    return task, shutdown
