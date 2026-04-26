"""session_reanimator — auto-resume daemon for stalled agent sessions.

Phase I of the agent-claw autonomy upgrade
(see docs/plans/agent-claw-autonomy-upgrade.md).

Every POLL_INTERVAL_SECONDS, finds agent_sessions where:
  - last_finish_reason ∈ ('max_steps', 'stop')   — never paused on a question
  - auto_resume_count < auto_resume_cap          — under the loop guard
  - session_input_tokens < session_token_budget  — under the per-session cap
  - has at least one in_progress todo            — there's still work to do
  - updated_at < NOW() - INTERVAL '5 minutes'    — give the user time to interject

For each match, POSTs /api/sessions/:id/resume on the agent. The agent
runs one more harness turn with a synthetic "Continue with the next step"
prompt; the response is logged here so operators can spot loops.

Stop conditions are encoded in the agent route — this daemon trusts
them. If we wake a session that the route refuses (auto_resume_cap_reached,
session_budget_exceeded, awaiting_user_input), we just log + skip on the
next poll.

Auth:
  Connects to the agent as the configured CHEMCLAW_DEV_USER_EMAIL header
  (dev) or X-Internal-Service-Token (production — TODO: ADR 006 Layer 2
  to mint a JWT instead of a header). Until then, this daemon must run
  on the same private network as the agent.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

import httpx
import psycopg
from psycopg.rows import dict_row
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger("session-reanimator")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Postgres — must use chemclaw_service (BYPASSRLS) so the daemon can read
    # all users' agent_sessions rows. Filtering happens in the SQL.
    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_db: str = "chemclaw"
    postgres_user: str = "chemclaw_service"
    postgres_password: str = ""

    # Agent service.
    agent_base_url: str = "http://agent-claw:3101"
    # Header the agent reads for the calling user's identity. The daemon
    # must impersonate the session's owning user so RLS scopes correctly
    # at the agent boundary.
    agent_user_header: str = "x-user-entra-id"

    # Polling cadence.
    poll_interval_seconds: int = 300  # 5 min
    batch_size: int = 10
    # How long since the session's updated_at before considering it stale.
    stale_after_seconds: int = 300

    log_level: str = "INFO"

    @property
    def postgres_dsn(self) -> str:
        return (
            f"host={self.postgres_host} port={self.postgres_port} "
            f"dbname={self.postgres_db} user={self.postgres_user} "
            f"password={self.postgres_password}"
        )


# ---------------------------------------------------------------------------
# Find sessions ready for auto-resume.
# ---------------------------------------------------------------------------

_FIND_RESUMABLE_SQL = """
SELECT s.id::text AS id,
       s.user_entra_id,
       s.last_finish_reason,
       s.auto_resume_count,
       s.auto_resume_cap,
       s.session_input_tokens,
       COALESCE(s.session_token_budget, 1000000) AS session_token_budget
  FROM agent_sessions s
 WHERE s.last_finish_reason IN ('max_steps', 'stop')
   AND s.auto_resume_count < s.auto_resume_cap
   AND s.session_input_tokens < COALESCE(s.session_token_budget, 1000000)
   AND s.updated_at < NOW() - make_interval(secs => %s)
   AND EXISTS (
     SELECT 1 FROM agent_todos t
      WHERE t.session_id = s.id
        AND t.status = 'in_progress'
   )
 ORDER BY s.updated_at ASC
 LIMIT %s
"""


async def find_resumable(settings: Settings) -> list[dict[str, Any]]:
    async with await psycopg.AsyncConnection.connect(
        settings.postgres_dsn,
        row_factory=dict_row,
    ) as conn, conn.cursor() as cur:
        await cur.execute(
            _FIND_RESUMABLE_SQL,
            (settings.stale_after_seconds, settings.batch_size),
        )
        return list(await cur.fetchall())


# ---------------------------------------------------------------------------
# POST to the agent's resume endpoint.
# ---------------------------------------------------------------------------


async def resume_session(
    client: httpx.AsyncClient,
    settings: Settings,
    session_id: str,
    user_entra_id: str,
) -> dict[str, Any]:
    headers = {settings.agent_user_header: user_entra_id}
    url = f"{settings.agent_base_url.rstrip('/')}/api/sessions/{session_id}/resume"
    r = await client.post(url, headers=headers, timeout=120.0)
    if r.status_code == 409:
        # Expected for awaiting_user_input or auto_resume_cap_reached.
        return {"ok": False, "status": 409, "body": r.json()}
    if r.status_code >= 400:
        return {"ok": False, "status": r.status_code, "body": r.text[:500]}
    return {"ok": True, "status": 200, "body": r.json()}


# ---------------------------------------------------------------------------
# Main loop.
# ---------------------------------------------------------------------------


async def amain() -> None:
    settings = Settings()
    logging.basicConfig(level=settings.log_level)
    log.info(
        "session-reanimator starting; agent=%s poll=%ds batch=%d",
        settings.agent_base_url,
        settings.poll_interval_seconds,
        settings.batch_size,
    )

    async with httpx.AsyncClient() as client:
        while True:
            tick_started = datetime.now(timezone.utc)
            try:
                resumable = await find_resumable(settings)
                if resumable:
                    log.info("found %d session(s) ready to resume", len(resumable))
                else:
                    log.debug("no sessions to resume this tick")

                for row in resumable:
                    sid = row["id"]
                    uid = row["user_entra_id"]
                    # Per-session try/except: a single failure (network,
                    # malformed JSON, hung tool) must not stall the rest of
                    # the batch. Without this, one bad session DOSes every
                    # peer in the same tick until the next 5-minute cycle.
                    try:
                        log.info(
                            "resuming session %s (user=%s, attempt=%d/%d)",
                            sid, uid, row["auto_resume_count"] + 1, row["auto_resume_cap"],
                        )
                        result = await resume_session(client, settings, sid, uid)
                        if result["ok"]:
                            body = result["body"]
                            log.info(
                                "session %s resumed: finish=%s steps=%d count=%d",
                                sid,
                                body.get("final_finish_reason"),
                                body.get("total_steps_used", 0),
                                body.get("auto_resume_count", 0),
                            )
                        else:
                            log.warning(
                                "session %s resume failed (%d): %s",
                                sid, result["status"], result["body"],
                            )
                    except Exception as session_exc:  # noqa: BLE001 — keep batch alive
                        log.exception(
                            "session %s resume raised; skipping to next: %s",
                            sid, session_exc,
                        )
            except Exception as exc:  # noqa: BLE001 — keep the loop alive
                log.exception("tick failed: %s", exc)

            elapsed = (datetime.now(timezone.utc) - tick_started).total_seconds()
            sleep_for = max(0, settings.poll_interval_seconds - int(elapsed))
            await asyncio.sleep(sleep_for)


def main() -> None:
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        log.info("session-reanimator stopped via KeyboardInterrupt")


if __name__ == "__main__":
    main()
