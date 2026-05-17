"""pattern_detector — nightly statistical cluster sweep daemon (Phase 4).

Runs every `PATTERN_DETECTOR_POLL_HOURS` (default 24). For each tick:

  1. For every predicate with >= MIN_CLUSTER_SIZE facts in the `facts` table
     that have a numeric object_value.value:
       a. Group fact values by subject_id_value.
       b. Compute population statistics: count, mean, std, min, max, quartiles.
       c. If the population is large enough (>= MIN_CLUSTER_SIZE) and has
          meaningful spread (cv >= CV_THRESHOLD or value range spans
          RANGE_THRESHOLD × std), emit a `pattern_detected` ingestion event
          with the cluster summary.
       d. Throttle: skip predicates that already had a pattern_detected event
          within the last COOLDOWN_HOURS hours (prevents flooding).
  2. Append a one-line summary to the log.

The detector is pure-Postgres — no LLM. Downstream `hypothesis_former`
consumes `pattern_detected` events and calls LiteLLM to form HYPOTHESIZED facts.

Connects as `chemclaw_service` (BYPASSRLS).
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import statistics
import time
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row
from pydantic_settings import BaseSettings, SettingsConfigDict

from services.mcp_tools.common.logging import configure_logging

log = logging.getLogger("pattern-detector")

_MIN_CLUSTER_SIZE = 5
_CV_THRESHOLD = 0.15       # coefficient of variation >= 15% signals meaningful spread
_RANGE_THRESHOLD = 2.0     # range >= 2 std also signals meaningful spread
_COOLDOWN_HOURS = 20       # don't re-emit same predicate pattern within this window


class PatternDetectorSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_db: str = "chemclaw"
    postgres_user: str = "chemclaw_service"
    postgres_password: str = ""

    pattern_detector_poll_hours: float = 24.0
    log_level: str = "INFO"

    @property
    def postgres_dsn(self) -> str:
        return (
            f"host={self.postgres_host} port={self.postgres_port} "
            f"dbname={self.postgres_db} user={self.postgres_user} "
            f"password={self.postgres_password}"
        )


# ---------------------------------------------------------------------------
# Pure statistics helpers
# ---------------------------------------------------------------------------


def compute_cluster_stats(values: list[float]) -> dict[str, Any] | None:
    """Return cluster summary dict or None if the cluster is not significant."""
    if len(values) < _MIN_CLUSTER_SIZE:
        return None
    n = len(values)
    mean = statistics.mean(values)
    try:
        stdev = statistics.stdev(values)
    except statistics.StatisticsError:
        stdev = 0.0
    vmin = min(values)
    vmax = max(values)
    value_range = vmax - vmin

    # Coefficient of variation (relative dispersion)
    cv = stdev / abs(mean) if mean != 0 else float("inf")

    # Significance check: either high relative spread or large absolute range
    if cv < _CV_THRESHOLD and (stdev == 0 or value_range < _RANGE_THRESHOLD * stdev):
        return None

    try:
        q1 = statistics.quantiles(values, n=4)[0]
        q3 = statistics.quantiles(values, n=4)[2]
    except statistics.StatisticsError:
        q1 = mean
        q3 = mean

    return {
        "count": n,
        "mean": round(mean, 4),
        "stdev": round(stdev, 4),
        "min": round(vmin, 4),
        "max": round(vmax, 4),
        "q1": round(q1, 4),
        "q3": round(q3, 4),
        "cv": round(cv, 4),
        "range": round(value_range, 4),
    }


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


async def _fetch_numeric_predicates(
    conn: psycopg.AsyncConnection[dict[str, Any]],
) -> list[str]:
    """Return predicates that have >= MIN_CLUSTER_SIZE numeric facts."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT predicate
            FROM facts
            WHERE object_value ? 'value'
              AND jsonb_typeof(object_value->'value') = 'number'
            GROUP BY predicate
            HAVING count(*) >= %s
            ORDER BY count(*) DESC
            LIMIT 500
            """,
            (_MIN_CLUSTER_SIZE,),
        )
        rows = await cur.fetchall()
    return [r.get("predicate") if isinstance(r, dict) else r[0] for r in rows]


async def _fetch_predicate_values(
    conn: psycopg.AsyncConnection[dict[str, Any]], predicate: str
) -> list[float]:
    """Return all numeric values for a predicate across all subjects."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT (object_value->>'value')::float AS v
            FROM facts
            WHERE predicate = %s
              AND object_value ? 'value'
              AND jsonb_typeof(object_value->'value') = 'number'
            LIMIT 5000
            """,
            (predicate,),
        )
        rows = await cur.fetchall()
    out: list[float] = []
    for r in rows:
        try:
            v = r.get("v") if isinstance(r, dict) else r[0]
            if v is not None:
                out.append(float(v))
        except (TypeError, ValueError):
            pass
    return out


async def _was_recently_emitted(
    conn: psycopg.AsyncConnection[dict[str, Any]], predicate: str
) -> bool:
    """Return True if pattern_detected was emitted for this predicate within COOLDOWN_HOURS."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT 1 FROM ingestion_events
            WHERE event_type = 'pattern_detected'
              AND payload->>'predicate' = %s
              AND created_at > NOW() - make_interval(hours => %s)
            LIMIT 1
            """,
            (predicate, _COOLDOWN_HOURS),
        )
        row = await cur.fetchone()
    return row is not None


async def _fetch_compound_inchikeys(
    conn: psycopg.AsyncConnection[dict[str, Any]], predicate: str
) -> list[str]:
    """Return distinct InChIKeys of Compound subjects for a predicate (≤ 50)."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT DISTINCT subject_id_value
            FROM facts
            WHERE predicate = %s AND subject_label = 'Compound' AND valid_to IS NULL
            LIMIT 50
            """,
            (predicate,),
        )
        rows = await cur.fetchall()
    return [
        (r.get("subject_id_value") if isinstance(r, dict) else r[0])
        for r in rows
        if (r.get("subject_id_value") if isinstance(r, dict) else r[0])
    ]


async def _emit_pattern_detected(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    predicate: str,
    stats: dict[str, Any],
) -> None:
    inchikeys = await _fetch_compound_inchikeys(conn, predicate)
    payload = {"predicate": predicate, "cluster": stats, "compound_inchikeys": inchikeys}
    async with conn.cursor() as cur:
        await cur.execute(
            "INSERT INTO ingestion_events (event_type, payload) "
            "VALUES ('pattern_detected', %s::jsonb)",
            (json.dumps(payload),),
        )


# ---------------------------------------------------------------------------
# Main sweep
# ---------------------------------------------------------------------------


async def run_sweep(conn: psycopg.AsyncConnection[dict[str, Any]]) -> int:
    """Run one full sweep. Returns number of patterns emitted."""
    predicates = await _fetch_numeric_predicates(conn)
    emitted = 0

    for predicate in predicates:
        if await _was_recently_emitted(conn, predicate):
            log.debug("pattern_detector: predicate %s in cooldown; skipping", predicate)
            continue

        values = await _fetch_predicate_values(conn, predicate)
        stats = compute_cluster_stats(values)
        if stats is None:
            continue

        await _emit_pattern_detected(conn, predicate, stats)
        await conn.commit()
        emitted += 1
        log.info(
            "pattern_detector: pattern_detected predicate=%s count=%d mean=%.3f cv=%.3f",
            predicate, stats["count"], stats["mean"], stats["cv"],
        )

    return emitted


async def _run_daemon(settings: PatternDetectorSettings) -> None:
    poll_seconds = settings.pattern_detector_poll_hours * 3600.0
    log.info(
        "pattern_detector: starting, poll_hours=%.1f", settings.pattern_detector_poll_hours
    )

    while True:
        try:
            async with await psycopg.AsyncConnection.connect(
                settings.postgres_dsn, row_factory=dict_row
            ) as conn:
                start = time.monotonic()
                emitted = await run_sweep(conn)
                elapsed = time.monotonic() - start
                log.info(
                    "pattern_detector: sweep done in %.1fs, emitted %d pattern events",
                    elapsed, emitted,
                )
        except Exception as exc:  # noqa: BLE001
            log.error("pattern_detector: sweep failed: %s", exc)

        await asyncio.sleep(poll_seconds)


def main() -> None:  # pragma: no cover
    settings = PatternDetectorSettings()
    configure_logging(settings.log_level)
    asyncio.run(_run_daemon(settings))


if __name__ == "__main__":  # pragma: no cover
    main()
