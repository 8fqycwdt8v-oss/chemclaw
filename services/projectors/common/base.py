"""Base class for Postgres LISTEN/NOTIFY projectors.

Each projector subscribes to the `ingestion_events` channel, deduplicates via
`projection_acks`, and applies event-specific logic in a subclass. Designed
to be idempotent — running the same projector twice yields the same result.

Operational model (critical invariants):
  1. LISTEN is issued FIRST so that any NOTIFY fired during catch-up lands in
     the buffer and is consumed after catch-up completes. This closes the
     "lost events in the seam" race.
  2. Catch-up loops until the backlog is drained (no arbitrary LIMIT truncation).
  3. The NOTIFY loop races against a shutdown Event so SIGTERM propagates
     promptly — no indefinite blocking on a quiet channel.
  4. Handler raises ⇒ event is NOT acked (retries on next NOTIFY). Handlers
     must be idempotent; see `BaseProjector.handle` docstring.

The module uses two Postgres connections:
  - `listen_conn` — autocommit, holds the LISTEN subscription
  - `work_conn`   — transactional, handles SELECT + ack UPSERT
"""

from __future__ import annotations

import asyncio
import json
import logging
import signal
from abc import ABC, abstractmethod
from typing import Any

import psycopg
from psycopg.rows import dict_row
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger("projector")

_CATCHUP_BATCH = 1000  # rows per iteration; loop until drained
_NOTIFY_POLL_TIMEOUT_S = 5.0  # how often we check the shutdown flag while idle


class ProjectorSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_db: str = "chemclaw"
    postgres_user: str = "chemclaw"
    postgres_password: str = ""
    projector_log_level: str = "INFO"

    @property
    def postgres_dsn(self) -> str:
        # Password injected only at connection time; not echoed into logs.
        return (
            f"host={self.postgres_host} port={self.postgres_port} "
            f"dbname={self.postgres_db} user={self.postgres_user} "
            f"password={self.postgres_password}"
        )


class PermanentHandlerError(Exception):
    """Raised by a handler when the event should be acked but no work done.

    Distinct from transient failures (network glitch, upstream 5xx) which
    should cause a retry. Handlers raising PermanentHandlerError will have
    their event acked — preventing retry storms on malformed data.
    """


class BaseProjector(ABC):
    """Subscribe to ingestion_events and project them idempotently.

    Subclasses define:
      - `name` (unique projector name, used as ack key)
      - `interested_event_types` (tuple of event_type strings handled)
      - `async handle(event_id, event_type, source_table, source_row_id, payload)`

    Handlers should:
      - Be idempotent (assume the same event may arrive twice).
      - Raise `PermanentHandlerError` for unrecoverable data errors (the
        event will still be acked).
      - Raise any other exception for transient failures (the event will be
        retried on the next NOTIFY).

    Custom NOTIFY channels (DR-06): Two existing projectors
    (compound_classifier, compound_fingerprinter) drive off custom
    pg_notify channels (`compound_fingerprinted`, `compound_changed`)
    where the payload is a domain key (inchikey) rather than an
    ingestion_events row id. They override `_connect_and_run` and set
    `interested_event_types = ()` so the default `_listen_loop` is
    bypassed entirely. If you need this pattern, follow their template:
    set the class docstring to name the channel + payload semantics
    explicitly, and keep `interested_event_types` empty so a future
    reader doesn't expect handle() to fire.
    """

    name: str = "base"
    interested_event_types: tuple[str, ...] = ()

    def __init__(self, settings: ProjectorSettings) -> None:
        self.settings = settings
        self._shutdown = asyncio.Event()

    # ----- subclass hook ---------------------------------------------------
    @abstractmethod
    async def handle(
        self,
        *,
        event_id: str,
        event_type: str,
        source_table: str | None,
        source_row_id: str | None,
        payload: dict[str, Any],
    ) -> None: ...

    # ----- main loop -------------------------------------------------------
    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, self._shutdown.set)
            except NotImplementedError:
                # Windows or restricted envs — ignore; shutdown via the Event
                # can still be set programmatically.
                pass

        log.info("[%s] starting", self.name)

        # Reconnect loop with exponential backoff. A transient Postgres blip
        # (failover, idle eviction) used to kill the whole process; now we
        # reopen the LISTEN + work connection and resume from the durable
        # cursor in projection_acks. Replays remain safe because every
        # handler is idempotent (per the design invariant in CLAUDE.md).
        backoff = 1.0
        max_backoff = 30.0
        while not self._shutdown.is_set():
            try:
                await self._connect_and_run()
                # Clean exit (shutdown event set inside _connect_and_run).
                break
            except (psycopg.OperationalError, OSError) as exc:
                if self._shutdown.is_set():
                    break
                log.warning(
                    "[%s] DB connection error: %s — reconnecting in %.1fs",
                    self.name, exc, backoff,
                )
                try:
                    await asyncio.wait_for(self._shutdown.wait(), timeout=backoff)
                    break  # shutdown raced backoff
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, max_backoff)
            except Exception:
                # Non-DB errors propagate — they likely indicate a real bug.
                raise

        log.info("[%s] stopped", self.name)

    async def _connect_and_run(self) -> None:
        """One full cycle: open both connections, catch up, listen, until DB drops."""
        # OPEN LISTEN FIRST so NOTIFYs during catch-up land in the buffer.
        async with await psycopg.AsyncConnection.connect(
            self.settings.postgres_dsn,
            autocommit=True,
            row_factory=dict_row,
        ) as listen_conn:
            async with listen_conn.cursor() as cur:
                await cur.execute("LISTEN ingestion_events")
            log.info("[%s] LISTEN established", self.name)

            async with await psycopg.AsyncConnection.connect(
                self.settings.postgres_dsn,
                row_factory=dict_row,
            ) as work_conn:
                await self._catch_up(work_conn)
                log.info("[%s] catch-up complete", self.name)
                await self._listen_loop(listen_conn, work_conn)

    # ----- catch-up --------------------------------------------------------
    async def _catch_up(self, work_conn: psycopg.AsyncConnection[dict[str, Any]]) -> None:
        """Drain the backlog. Loops until no unprocessed events remain."""
        while not self._shutdown.is_set():
            async with work_conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT e.id::text AS id,
                           e.event_type,
                           e.source_table,
                           e.source_row_id::text AS source_row_id,
                           e.payload
                      FROM ingestion_events e
                     WHERE NOT EXISTS (
                       SELECT 1 FROM projection_acks a
                        WHERE a.event_id = e.id
                          AND a.projector_name = %s
                     )
                     ORDER BY e.created_at ASC
                     LIMIT %s
                    """,
                    (self.name, _CATCHUP_BATCH),
                )
                rows = await cur.fetchall()
            if not rows:
                return
            for row in rows:
                if self._shutdown.is_set():
                    return
                await self._process_row(work_conn, row)

    # ----- live LISTEN -----------------------------------------------------
    async def _listen_loop(
        self,
        listen_conn: psycopg.AsyncConnection[dict[str, Any]],
        work_conn: psycopg.AsyncConnection[dict[str, Any]],
    ) -> None:
        """Consume NOTIFY payloads until shutdown.

        psycopg3's `conn.notifies()` async generator yields notifies as they
        arrive. We race it against the shutdown event and a periodic timeout
        so that SIGTERM always wakes the loop within `_NOTIFY_POLL_TIMEOUT_S`.
        """
        notify_gen = listen_conn.notifies()
        # Next-notify task; recreated each iteration.
        next_notify_task: asyncio.Task[Any] | None = None
        shutdown_task = asyncio.create_task(self._shutdown.wait(), name="shutdown")

        try:
            while not self._shutdown.is_set():
                if next_notify_task is None or next_notify_task.done():
                    next_notify_task = asyncio.create_task(
                        notify_gen.__anext__(), name="next_notify"
                    )

                done, _pending = await asyncio.wait(
                    {next_notify_task, shutdown_task},
                    timeout=_NOTIFY_POLL_TIMEOUT_S,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if shutdown_task in done:
                    break
                if next_notify_task in done:
                    try:
                        notify = next_notify_task.result()
                    except StopAsyncIteration:
                        log.info("[%s] notify stream ended", self.name)
                        break
                    next_notify_task = None
                    await self._handle_notify(work_conn, notify.payload)
                # else: timeout — loop to re-check shutdown.
        finally:
            if next_notify_task and not next_notify_task.done():
                next_notify_task.cancel()
            if not shutdown_task.done():
                shutdown_task.cancel()

    async def _handle_notify(
        self, work_conn: psycopg.AsyncConnection[dict[str, Any]], raw_payload: str
    ) -> None:
        try:
            msg = json.loads(raw_payload)
        except json.JSONDecodeError:
            log.warning("[%s] unparseable NOTIFY payload: %r", self.name, raw_payload)
            return
        event_id = msg.get("id")
        if not event_id:
            return

        async with work_conn.cursor() as cur:
            await cur.execute(
                """
                SELECT e.id::text AS id,
                       e.event_type,
                       e.source_table,
                       e.source_row_id::text AS source_row_id,
                       e.payload
                  FROM ingestion_events e
                 WHERE e.id = %s::uuid
                   AND NOT EXISTS (
                     SELECT 1 FROM projection_acks a
                      WHERE a.event_id = e.id AND a.projector_name = %s
                   )
                """,
                (event_id, self.name),
            )
            row = await cur.fetchone()
        await work_conn.commit()
        if row is None:
            return
        await self._process_row(work_conn, row)

    # ----- dispatch --------------------------------------------------------
    async def _process_row(
        self, work_conn: psycopg.AsyncConnection[dict[str, Any]], row: dict[str, Any]
    ) -> None:
        import time as _t
        event_id = row["id"]
        event_type = row["event_type"]
        payload = row["payload"] or {}
        # Correlation ID: ingestion writers MAY include `request_id` in the
        # JSONB payload (sourced from the originating HTTP request's
        # `x-request-id` header / `request.state.request_id`). When present
        # we surface it on every log line for this event so a single trace
        # spans the HTTP boundary -> canonical INSERT -> projector. When
        # absent we silently fall back to the event id, keeping logs useful
        # for legacy ingesters that haven't been retrofitted yet.
        request_id = payload.get("request_id") if isinstance(payload, dict) else None
        # `extra` is merged into every log record by the LoggerAdapter so
        # downstream shippers (or a structured handler) can key on the field.
        log_ctx = logging.LoggerAdapter(
            log,
            {"request_id": request_id, "event_id": event_id, "projector": self.name},
        )
        should_ack = True
        started = _t.monotonic()

        try:
            if (
                self.interested_event_types
                and event_type not in self.interested_event_types
            ):
                # silent skip; still ack to stop scanning forever
                pass
            else:
                await self.handle(
                    event_id=event_id,
                    event_type=event_type,
                    source_table=row["source_table"],
                    source_row_id=row["source_row_id"],
                    payload=payload,
                )
        except PermanentHandlerError as exc:
            log_ctx.warning(
                "permanent handler error on event %s: %s (acking to stop retries)",
                event_id, exc,
                extra={
                    "event": "projector_handler_failed",
                    "error_code": "PROJECTOR_HANDLER_FAILED_PERMANENT",
                    "event_type": event_type,
                    "duration_ms": int((_t.monotonic() - started) * 1000),
                },
            )
        except Exception:
            log_ctx.exception(
                "transient handler error on event %s; NOT acking", event_id,
                extra={
                    "event": "projector_handler_failed",
                    "error_code": "PROJECTOR_HANDLER_FAILED_TRANSIENT",
                    "event_type": event_type,
                    "duration_ms": int((_t.monotonic() - started) * 1000),
                },
            )
            should_ack = False

        if not should_ack:
            return

        async with work_conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO projection_acks (event_id, projector_name)
                VALUES (%s::uuid, %s)
                ON CONFLICT DO NOTHING
                """,
                (event_id, self.name),
            )
        await work_conn.commit()
        log_ctx.info(
            "acked %s",
            event_id,
            extra={
                "event": "projector_ack",
                "event_type": event_type,
                "handler_duration_ms": int((_t.monotonic() - started) * 1000),
                "ack_status": "ok",
            },
        )
