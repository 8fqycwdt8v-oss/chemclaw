"""Skill promoter runner — runs as a post-GEPA nightly task.

Exposes /healthz for Docker healthcheck.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import psycopg
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI

from .promoter import run_promotion_pass, run_prompt_promotion_pass

logger = logging.getLogger(__name__)

_last_run_at: datetime | None = None
_last_run_status: str = "never"
_last_events: list[dict[str, Any]] = []


def _get_dsn() -> str:
    return (
        f"host={os.environ.get('POSTGRES_HOST', 'localhost')} "
        f"port={os.environ.get('POSTGRES_PORT', '5432')} "
        f"dbname={os.environ.get('POSTGRES_DB', 'chemclaw')} "
        f"user={os.environ.get('POSTGRES_USER', 'chemclaw')} "
        f"password={os.environ.get('POSTGRES_PASSWORD', '')}"
    )


async def run_skill_promoter_job() -> None:
    global _last_run_at, _last_run_status, _last_events

    _last_run_at = datetime.now(tz=timezone.utc)
    _last_run_status = "running"

    try:
        dsn = _get_dsn()
        with psycopg.connect(dsn) as conn:
            skill_events = run_promotion_pass(conn)
            prompt_events = run_prompt_promotion_pass(conn)
            events = skill_events + prompt_events
        _last_events = [
            {
                "skill_name": e.skill_name,
                "version": e.version,
                "event_type": e.event_type,
                "reason": e.reason,
            }
            for e in events
        ]
        _last_run_status = "ok"
        logger.info("Skill promotion pass complete: %d events", len(events))
    except Exception as exc:
        logger.exception("Skill promotion pass failed: %s", exc)
        _last_run_status = "error"
        _last_events = []


scheduler = AsyncIOScheduler()


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # Run after the GEPA run (02:30 UTC).
    scheduler.add_job(
        run_skill_promoter_job,
        "cron",
        hour=2,
        minute=30,
        id="skill_promoter_nightly",
        replace_existing=True,
    )
    scheduler.start()
    logger.info("Skill promoter scheduler started (02:30 UTC nightly)")
    yield
    scheduler.shutdown()


app = FastAPI(lifespan=_lifespan)


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {
        "service": "skill-promoter",
        "status": "ok",
        "last_run_at": _last_run_at.isoformat() if _last_run_at else None,
        "last_run_status": _last_run_status,
        "recent_events": _last_events[-20:],
    }


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("SKILL_PROMOTER_PORT", "8011")))
