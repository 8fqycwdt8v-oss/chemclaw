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
  Mints an HS256 JWT scoped to `agent:resume` (per ADR 006 Layer 2,
  see services/mcp_tools/common/auth.py) and POSTs to the agent's
  /api/internal/sessions/:id/resume endpoint, which trusts only the
  signed `claims.user`. No `x-user-entra-id` forgery surface.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx
import psycopg
from psycopg.rows import dict_row
from pydantic_settings import BaseSettings, SettingsConfigDict

from services.mcp_tools.common.auth import McpAuthError, sign_mcp_token

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

    # MCP signing key shared with the agent. The daemon mints a per-call JWT
    # carrying the session's owning user as the `user` claim and the
    # `agent:resume` scope; the agent's /api/internal/sessions/:id/resume
    # route verifies and trusts only the signed claim (no x-user-entra-id
    # forgery surface). When unset, the daemon falls back to the legacy
    # x-user-entra-id header for the public /api/sessions/:id/resume route
    # — useful in dev where MCP_AUTH_SIGNING_KEY isn't configured.
    mcp_auth_signing_key: str = ""

    # When false (default), an unset / empty mcp_auth_signing_key is fatal at
    # startup — production must mint a real JWT, never fall back to the
    # spoofable x-user-entra-id header against the public resume route. Set
    # to true ONLY in dev / local-stack to permit the legacy header path.
    chemclaw_dev_mode: bool = False

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

    def assert_production_safe(self) -> None:
        """Refuse to start in production with no signing key.

        The daemon's JWT-bound /api/internal/sessions/:id/resume call is the
        ONLY path the agent's RLS contract trusts; the legacy header path
        against /api/sessions/:id/resume is spoofable by anything that can
        reach the agent's HTTP port. A production deployment with the
        signing key accidentally unset (e.g., bad secret refs in helm)
        would silently downgrade to the spoofable path. This guard makes
        that misconfiguration loud at startup.
        """
        if self.chemclaw_dev_mode:
            return
        if not self.mcp_auth_signing_key.strip():
            raise RuntimeError(
                "session_reanimator: mcp_auth_signing_key is unset in "
                "production-mode (chemclaw_dev_mode=false). The daemon "
                "would silently fall back to the spoofable x-user-entra-id "
                "header path against the public resume route. Set "
                "MCP_AUTH_SIGNING_KEY (>=32 chars) or, ONLY for dev / "
                "local-stack, set CHEMCLAW_DEV_MODE=true."
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
    """POST the agent's resume endpoint for one session.

    Auth strategy:
      - When MCP_AUTH_SIGNING_KEY is configured: mint a JWT with the
        session's owning user as `user` and scope `agent:resume`, send to
        /api/internal/sessions/:id/resume (which trusts ONLY the signed
        claim — no header forgery surface). This is the production path.
      - Otherwise: fall back to the legacy x-user-entra-id header against
        the public /api/sessions/:id/resume route. This is the dev-mode
        path (and also acceptable for one-off ops use behind the auth
        proxy where header forgery isn't a concern).
    """
    base = settings.agent_base_url.rstrip("/")
    # Mint a fresh request_id per resume so the agent-claw log line, the
    # plan/run inner harness, the projector handlers, and the
    # error_events row (if anything fails) can all be tied back to this
    # specific tick + session. Without this, every reanimator-triggered
    # resume on the agent side gets a randomly-generated UUID and the
    # tick summary loses any link to the per-session work it caused.
    request_id = str(uuid.uuid4())
    headers: dict[str, str] = {"x-request-id": request_id}
    url: str

    if settings.mcp_auth_signing_key:
        try:
            # audience="agent-claw" binds the token to the resume route
            # specifically — the verifier rejects tokens with any other
            # `aud` claim. Keep this literal in sync with
            # `verifyBearerHeader({expectedAudience: "agent-claw"})` in
            # services/agent-claw/src/routes/sessions-handlers.ts.
            token = sign_mcp_token(
                sandbox_id="reanimator",
                user_entra_id=user_entra_id,
                scopes=["agent:resume"],
                audience="agent-claw",
                ttl_seconds=300,
                signing_key=settings.mcp_auth_signing_key,
            )
            headers["Authorization"] = f"Bearer {token}"
            url = f"{base}/api/internal/sessions/{session_id}/resume"
        except McpAuthError as exc:
            log.error("failed to mint resume token for session %s: %s", session_id, exc)
            return {"ok": False, "status": 0, "body": f"token-mint-failed: {exc}"}
    else:
        headers["x-user-entra-id"] = user_entra_id
        url = f"{base}/api/sessions/{session_id}/resume"

    r = await client.post(url, headers=headers, timeout=120.0)
    if r.status_code == 409:
        return {"ok": False, "status": 409, "body": r.json()}
    if r.status_code >= 400:
        return {"ok": False, "status": r.status_code, "body": r.text[:500]}
    return {"ok": True, "status": 200, "body": r.json()}


# ---------------------------------------------------------------------------
# Main loop.
# ---------------------------------------------------------------------------


async def amain() -> None:  # pragma: no cover — process entrypoint
    settings = Settings()
    from services.mcp_tools.common.logging import configure_logging
    configure_logging(settings.log_level, service="session_reanimator")
    # Hard-fail in production-mode if no signing key — see Settings docstring.
    settings.assert_production_safe()
    log.info(
        "session-reanimator starting; agent=%s poll=%ds batch=%d dev_mode=%s",
        settings.agent_base_url,
        settings.poll_interval_seconds,
        settings.batch_size,
        settings.chemclaw_dev_mode,
    )

    async with httpx.AsyncClient() as client:
        while True:
            tick_started = datetime.now(timezone.utc)
            sessions_resumed = 0
            sessions_skipped = 0
            errors = 0
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
                            "resuming session %s (attempt=%d/%d)",
                            sid, row["auto_resume_count"] + 1, row["auto_resume_cap"],
                        )
                        result = await resume_session(client, settings, sid, uid)
                        if result["ok"]:
                            body = result["body"]
                            sessions_resumed += 1
                            log.info(
                                "session %s resumed: finish=%s steps=%d count=%d",
                                sid,
                                body.get("final_finish_reason"),
                                body.get("total_steps_used", 0),
                                body.get("auto_resume_count", 0),
                            )
                        else:
                            sessions_skipped += 1
                            log.warning(
                                "session %s resume failed (%d): %s",
                                sid, result["status"], result["body"],
                            )
                    except Exception as session_exc:  # noqa: BLE001 — keep batch alive
                        errors += 1
                        log.exception(
                            "session %s resume raised; skipping to next: %s",
                            sid, session_exc,
                        )
            except Exception as exc:  # noqa: BLE001 — keep the loop alive
                errors += 1
                log.exception("tick failed: %s", exc)

            elapsed = (datetime.now(timezone.utc) - tick_started).total_seconds()
            # Tick summary — single record per tick so a Loki query can
            # plot reanimator activity by minute without grepping every
            # per-session line.
            log.info(
                "reanimator tick complete",
                extra={
                    "event": "reanimator_tick",
                    "tick_duration_ms": int(elapsed * 1000),
                    "sessions_resumed": sessions_resumed,
                    "sessions_skipped": sessions_skipped,
                    "errors": errors,
                },
            )
            sleep_for = max(0, settings.poll_interval_seconds - int(elapsed))
            await asyncio.sleep(sleep_for)


def main() -> None:
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        log.info("session-reanimator stopped via KeyboardInterrupt")


if __name__ == "__main__":
    main()
