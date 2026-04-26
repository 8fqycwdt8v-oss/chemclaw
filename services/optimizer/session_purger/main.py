"""session_purger — TTL daemon for the agent_sessions table.

Companion to session_reanimator. Whereas the reanimator wakes stalled
sessions that still have work to do, this daemon evicts dead ones whose
expires_at has passed (default: created_at + 7 days, see
db/init/13_agent_sessions.sql).

Without this purger the table grows unbounded — every chat turn creates
or touches a row, and the index over (user_entra_id, updated_at) is the
hot path for the resume routes. Stale rows hurt query plans and waste
storage.

Cascade behavior:
  * agent_todos.session_id → ON DELETE CASCADE       (done by 13_agent_sessions.sql)
  * agent_plans.session_id → ON DELETE CASCADE       (done by 14_agent_session_extensions.sql)

So a single DELETE on agent_sessions cleans up the dependent rows.

Auth:
  Connects as chemclaw_service (BYPASSRLS) so it can purge across all users
  in one statement. The DELETE is unconditional on expires_at — there is no
  per-user filtering needed.

Safety:
  * Bounded batch size (default 1000) so we can't lock the table for a long time.
  * RETURNING id so we know how many rows we evicted; logged at INFO.
  * Idempotent — running twice in close succession is harmless (the second
    run finds nothing).
  * Honors a hard floor (MIN_AGE_HOURS) below which we refuse to purge,
    even if expires_at is past. Defends against an operator accidentally
    setting expires_at backwards via psql.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

import psycopg
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger("session-purger")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Postgres — chemclaw_service (BYPASSRLS) so the daemon can DELETE across users.
    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_db: str = "chemclaw"
    postgres_user: str = "chemclaw_service"
    postgres_password: str = ""

    # Polling cadence. The default ticks once an hour; the table is small
    # enough that more frequent runs add no value.
    poll_interval_seconds: int = 3600

    # Max rows per batch. With 1000 the DELETE returns within a few hundred
    # milliseconds even on a hot table; raise only if the backlog is huge.
    batch_size: int = 1000

    # Minimum row age before purge is allowed, regardless of expires_at.
    # Defends against an accidental backdated expires_at.
    min_age_hours: int = 1

    log_level: str = "INFO"

    @property
    def postgres_dsn(self) -> str:
        return (
            f"host={self.postgres_host} port={self.postgres_port} "
            f"dbname={self.postgres_db} user={self.postgres_user} "
            f"password={self.postgres_password}"
        )


# DELETE expired rows in a bounded batch. The CTE pre-selects the eviction
# candidates so the row lock is taken on a small set, not the whole table.
# Cascade FKs handle agent_todos and agent_plans.
_DELETE_EXPIRED_SQL = """
WITH victims AS (
  SELECT id
    FROM agent_sessions
   WHERE expires_at < NOW()
     AND created_at < NOW() - make_interval(hours => %s)
   ORDER BY expires_at ASC
   LIMIT %s
   FOR UPDATE SKIP LOCKED
)
DELETE FROM agent_sessions s
 USING victims v
 WHERE s.id = v.id
RETURNING s.id::text
"""


async def purge_once(settings: Settings) -> list[str]:
    """Run one purge tick. Returns the IDs of evicted sessions (for logging)."""
    async with await psycopg.AsyncConnection.connect(settings.postgres_dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                _DELETE_EXPIRED_SQL,
                (settings.min_age_hours, settings.batch_size),
            )
            rows = await cur.fetchall()
        await conn.commit()
        return [r[0] for r in rows]


async def amain() -> None:
    settings = Settings()
    logging.basicConfig(level=settings.log_level)
    log.info(
        "session-purger starting; poll=%ds batch=%d min_age=%dh",
        settings.poll_interval_seconds,
        settings.batch_size,
        settings.min_age_hours,
    )

    while True:
        tick_started = datetime.now(timezone.utc)
        try:
            evicted = await purge_once(settings)
            if evicted:
                log.info("purged %d expired session(s)", len(evicted))
                # Sample a few IDs so operators can audit; log all if small batch.
                sample = evicted if len(evicted) <= 5 else evicted[:5] + ["..."]
                log.debug("purged ids: %s", sample)
            else:
                log.debug("no expired sessions this tick")
        except Exception as exc:  # noqa: BLE001 — keep the loop alive
            log.exception("purge tick failed: %s", exc)

        elapsed = (datetime.now(timezone.utc) - tick_started).total_seconds()
        sleep_for = max(0, settings.poll_interval_seconds - int(elapsed))
        await asyncio.sleep(sleep_for)


def main() -> None:
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        log.info("session-purger stopped via KeyboardInterrupt")


if __name__ == "__main__":
    main()
