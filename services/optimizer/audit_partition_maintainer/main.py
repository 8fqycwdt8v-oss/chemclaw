"""audit_partition_maintainer — keeps the next two months of audit_log
partitions ahead of the clock.

`db/init/19_observability.sql` bootstraps three monthly partitions of
`audit_log` at init time (current month + 2). After ~90 days every
INSERT into a not-yet-created partition fails; the trigger swallows
exceptions via EXCEPTION WHEN OTHERS so the user-facing write succeeds,
but the audit row is silently dropped — exactly the failure mode the
2026-05-03 review flagged (P1 finding M18).

This daemon runs daily at low traffic, computes the next month boundary,
and ensures a partition exists for it. Idempotent.

Connects as chemclaw_service (BYPASSRLS) so it can issue DDL on the
audit_log parent table even though the table owner is chemclaw.
"""

from __future__ import annotations

import asyncio
import logging
import signal
from datetime import datetime, timedelta, timezone

import psycopg
from pydantic_settings import BaseSettings, SettingsConfigDict

from services.mcp_tools.common.logging import configure_logging

log = logging.getLogger("audit_partition_maintainer")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_db: str = "chemclaw"
    postgres_user: str = "chemclaw_service"
    postgres_password: str = ""

    log_level: str = "INFO"

    # How many months ahead to keep partitions. Three is enough headroom that
    # even a missed daily run doesn't lose audit rows; not so many that the
    # planner has hundreds of partitions to consider.
    months_ahead: int = 3

    # Tick once a day. Cheap idempotent DDL; no point firing more often.
    poll_interval_seconds: int = 86_400

    @property
    def dsn(self) -> str:
        return (
            f"host={self.postgres_host} port={self.postgres_port} "
            f"dbname={self.postgres_db} user={self.postgres_user} "
            f"password={self.postgres_password}"
        )


async def _ensure_partitions(settings: Settings) -> None:
    # Delegates to a SECURITY DEFINER function owned by chemclaw (defined in
    # db/init/32_rls_completeness.sql). The daemon connects as
    # chemclaw_service which is granted EXECUTE on the function but does not
    # own audit_log; partition creation requires ownership of the parent,
    # so the function is the privilege-bridge.
    months_ahead = int(settings.months_ahead)
    async with await psycopg.AsyncConnection.connect(settings.dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT ensure_audit_log_partitions(%s)", (months_ahead,)
            )
            row = await cur.fetchone()
        await conn.commit()
    n_created = row[0] if row else 0
    log.info(
        "ensured audit_log partitions for %d months ahead (%d new)",
        months_ahead,
        n_created,
    )


async def main() -> None:
    settings = Settings()
    configure_logging(settings.log_level, service="audit_partition_maintainer")

    shutdown = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, shutdown.set)
        except NotImplementedError:
            pass

    log.info("audit_partition_maintainer starting (interval=%ds)", settings.poll_interval_seconds)
    while not shutdown.is_set():
        try:
            await _ensure_partitions(settings)
        except Exception:  # noqa: BLE001
            log.exception("partition maintenance run failed; retrying next tick")

        try:
            await asyncio.wait_for(shutdown.wait(), timeout=settings.poll_interval_seconds)
        except asyncio.TimeoutError:
            pass

    log.info("audit_partition_maintainer stopped")


if __name__ == "__main__":
    asyncio.run(main())
