"""task_queue worker — leases pending tasks and dispatches to the right MCP service.

Concurrency / safety:
  - SELECT ... FOR UPDATE SKIP LOCKED so N replicas don't double-lease.
  - Lease expires after `QUEUE_LEASE_SECONDS`; expired-leased rows revert to
    pending automatically on the next sweep.
  - Idempotency: each task_kind+idempotency_key insert is a no-op.

Handlers map task_kind → MCP HTTP POST. New kinds are added by extending
HANDLERS at the bottom of the file.

Driven by `pg_notify('task_queue_pending', task_kind)`; falls back to a
periodic poll if NOTIFYs are missed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import signal
import time
from typing import Any, Awaitable, Callable

import httpx
import psycopg
from psycopg.rows import dict_row
from pydantic_settings import BaseSettings, SettingsConfigDict

from services.mcp_tools.common.logging import configure_logging


log = logging.getLogger("queue.worker")


class WorkerSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_db: str = "chemclaw"
    postgres_user: str = "chemclaw_service"
    postgres_password: str = ""
    log_level: str = "INFO"
    queue_concurrency: int = 4
    queue_lease_seconds: int = 300
    queue_tasks: str = "qm,genchem,classifier"
    poll_interval_seconds: int = 30  # belt-and-suspenders: poll even if no NOTIFYs

    # MCP base URLs
    mcp_xtb_url: str = "http://mcp-xtb:8010"
    mcp_crest_url: str = "http://mcp-crest:8014"
    mcp_genchem_url: str = "http://mcp-genchem:8015"

    @property
    def dsn(self) -> str:
        return (
            f"host={self.postgres_host} port={self.postgres_port} "
            f"dbname={self.postgres_db} user={self.postgres_user} "
            f"password={self.postgres_password}"
        )


# ---------------------------------------------------------------------------
# Handlers — task_kind -> async (payload) -> result
# ---------------------------------------------------------------------------


def _build_handlers(settings: WorkerSettings) -> dict[str, Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]]:
    client = httpx.AsyncClient(timeout=600.0)

    async def post(url: str, body: dict[str, Any]) -> dict[str, Any]:
        resp = await client.post(url, json=body)
        if resp.status_code >= 400:
            raise RuntimeError(f"{url} → {resp.status_code}: {resp.text[:200]}")
        return resp.json()

    async def qm_single_point(p: dict[str, Any]) -> dict[str, Any]:
        return await post(f"{settings.mcp_xtb_url}/single_point", p)

    async def qm_geometry_opt(p: dict[str, Any]) -> dict[str, Any]:
        return await post(f"{settings.mcp_xtb_url}/geometry_opt", p)

    async def qm_frequencies(p: dict[str, Any]) -> dict[str, Any]:
        return await post(f"{settings.mcp_xtb_url}/frequencies", p)

    async def qm_fukui(p: dict[str, Any]) -> dict[str, Any]:
        return await post(f"{settings.mcp_xtb_url}/fukui", p)

    async def qm_crest_conformers(p: dict[str, Any]) -> dict[str, Any]:
        return await post(f"{settings.mcp_crest_url}/conformers", p)

    async def genchem_scaffold(p: dict[str, Any]) -> dict[str, Any]:
        return await post(f"{settings.mcp_genchem_url}/scaffold_decorate", p)

    async def genchem_bioisostere(p: dict[str, Any]) -> dict[str, Any]:
        return await post(f"{settings.mcp_genchem_url}/bioisostere_replace", p)

    return {
        "qm_single_point":    qm_single_point,
        "qm_geometry_opt":    qm_geometry_opt,
        "qm_frequencies":     qm_frequencies,
        "qm_fukui":           qm_fukui,
        "qm_crest_conformers": qm_crest_conformers,
        "genchem_scaffold":   genchem_scaffold,
        "genchem_bioisostere": genchem_bioisostere,
    }


# ---------------------------------------------------------------------------
# Lease loop
# ---------------------------------------------------------------------------


class QueueWorker:
    def __init__(self, settings: WorkerSettings) -> None:
        self.settings = settings
        self._shutdown = asyncio.Event()
        self._handlers = _build_handlers(settings)
        self._task_kinds = [k.strip() for k in settings.queue_tasks.split(",") if k.strip()]
        self._sema = asyncio.Semaphore(settings.queue_concurrency)
        self._lease_id = f"{socket.gethostname()}/{os.getpid()}"

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, self._shutdown.set)
            except NotImplementedError:
                pass

        log.info("[queue] worker starting; lease_id=%s tasks=%s", self._lease_id, self._task_kinds)
        async with await psycopg.AsyncConnection.connect(
            self.settings.dsn, autocommit=True, row_factory=dict_row,
        ) as listen_conn:
            for k in self._task_kinds:
                async with listen_conn.cursor() as cur:
                    await cur.execute("LISTEN task_queue_pending")
            log.info("[queue] LISTEN task_queue_pending established")

            async with await psycopg.AsyncConnection.connect(
                self.settings.dsn, row_factory=dict_row,
            ) as work_conn:
                # Initial sweep + periodic polling alongside NOTIFY-driven dispatch.
                await self._sweep_all(work_conn)
                while not self._shutdown.is_set():
                    notify_task = asyncio.create_task(self._next_notify(listen_conn))
                    poll_task = asyncio.create_task(asyncio.sleep(self.settings.poll_interval_seconds))
                    shutdown_task = asyncio.create_task(self._shutdown.wait())
                    done, pending = await asyncio.wait(
                        {notify_task, poll_task, shutdown_task},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    for p in pending:
                        p.cancel()
                    if shutdown_task in done:
                        break
                    await self._sweep_all(work_conn)

        log.info("[queue] worker stopped")

    async def _next_notify(self, listen_conn: psycopg.AsyncConnection) -> str:
        gen = listen_conn.notifies()
        notify = await gen.__anext__()
        return notify.payload or ""

    async def _sweep_all(self, work_conn: psycopg.AsyncConnection) -> None:
        # Reclaim expired leases.
        async with work_conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE task_queue
                   SET status = 'pending', leased_by = NULL, lease_expires_at = NULL
                 WHERE status = 'leased' AND lease_expires_at < NOW()
                """
            )
        await work_conn.commit()

        for kind in self._task_kinds:
            if self._shutdown.is_set():
                return
            await self._dispatch_kind(work_conn, kind)

    async def _dispatch_kind(self, work_conn: psycopg.AsyncConnection, kind: str) -> None:
        leased = await self._lease_one(work_conn, kind)
        while leased is not None and not self._shutdown.is_set():
            asyncio.create_task(self._handle_with_sema(leased))
            leased = await self._lease_one(work_conn, kind)

    async def _lease_one(self, work_conn: psycopg.AsyncConnection, kind: str) -> dict[str, Any] | None:
        async with work_conn.cursor() as cur:
            await cur.execute(
                """
                WITH next_task AS (
                  SELECT id
                    FROM task_queue
                   WHERE status = 'pending'
                     AND task_kind LIKE %s
                   ORDER BY priority DESC, created_at
                   FOR UPDATE SKIP LOCKED
                   LIMIT 1
                )
                UPDATE task_queue t
                   SET status = 'leased',
                       leased_by = %s,
                       lease_expires_at = NOW() + (%s || ' seconds')::interval,
                       started_at = COALESCE(started_at, NOW()),
                       attempts = attempts + 1
                  FROM next_task n
                 WHERE t.id = n.id
                RETURNING t.id::text AS id, t.task_kind, t.payload, t.attempts, t.max_attempts, t.batch_id
                """,
                (f"{kind}%", self._lease_id, self.settings.queue_lease_seconds),
            )
            row = await cur.fetchone()
        await work_conn.commit()
        return row

    async def _handle_with_sema(self, row: dict[str, Any]) -> None:
        async with self._sema:
            await self._handle(row)

    async def _handle(self, row: dict[str, Any]) -> None:
        task_kind = row["task_kind"]
        payload = row["payload"] or {}
        handler = self._handlers.get(task_kind)
        if handler is None:
            await self._fail(row, f"no handler for task_kind={task_kind!r}")
            return

        try:
            result = await handler(payload)
        except Exception as exc:  # noqa: BLE001
            await self._maybe_retry(row, str(exc))
            return
        await self._succeed(row, result)

    async def _succeed(self, row: dict[str, Any], result: dict[str, Any]) -> None:
        async with await psycopg.AsyncConnection.connect(self.settings.dsn) as conn, conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE task_queue
                   SET status = 'succeeded',
                       finished_at = NOW(),
                       result = %s::jsonb,
                       leased_by = NULL,
                       lease_expires_at = NULL
                 WHERE id = %s::uuid
                """,
                (json.dumps(result), row["id"]),
            )
            await conn.commit()

    async def _fail(self, row: dict[str, Any], msg: str) -> None:
        async with await psycopg.AsyncConnection.connect(self.settings.dsn) as conn, conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE task_queue
                   SET status = 'failed',
                       finished_at = NOW(),
                       error = %s::jsonb,
                       leased_by = NULL,
                       lease_expires_at = NULL
                 WHERE id = %s::uuid
                """,
                (json.dumps({"error": msg}), row["id"]),
            )
            await conn.commit()

    async def _maybe_retry(self, row: dict[str, Any], msg: str) -> None:
        if row["attempts"] >= row["max_attempts"]:
            await self._fail(row, msg)
            return
        async with await psycopg.AsyncConnection.connect(self.settings.dsn) as conn, conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE task_queue
                   SET status = 'pending',
                       leased_by = NULL,
                       lease_expires_at = NULL,
                       error = %s::jsonb
                 WHERE id = %s::uuid
                """,
                (json.dumps({"transient": msg, "attempt": row["attempts"]}), row["id"]),
            )
            await conn.commit()


def main() -> None:
    settings = WorkerSettings()
    configure_logging(settings.log_level, service="queue-worker")
    worker = QueueWorker(settings)
    asyncio.run(worker.run())


if __name__ == "__main__":
    main()
