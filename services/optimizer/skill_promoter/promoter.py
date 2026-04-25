"""Skill promotion / demotion logic — Phase E.

Reads skill_library rows WHERE kind IN ('prompt', 'forged_tool').
Promotion gate:
  - success_count / total_runs >= 0.55
  - total_runs >= 30
  - For forged_tool: validator status='passing' in forged_tool_validation_runs.
Demotion gate:
  - success_count / total_runs < 0.40 over the last 30 runs
  → flip active=false; write feedback_events row (signal='auto_demoted').

A single pass is meant to run after the nightly GEPA run.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import psycopg

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Gates
# ---------------------------------------------------------------------------

PROMOTION_SUCCESS_RATE = 0.55
DEMOTION_SUCCESS_RATE = 0.40
MIN_RUNS = 30


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

@dataclass
class SkillRow:
    id: str
    name: str
    version: int
    kind: str
    active: bool
    success_count: int
    total_runs: int
    proposed_by_user_entra_id: str


@dataclass
class PromotionEvent:
    skill_name: str
    version: int
    event_type: str
    reason: str
    metadata: dict[str, Any]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _success_rate(skill: SkillRow) -> float | None:
    """Return success rate or None if total_runs < MIN_RUNS."""
    if skill.total_runs < MIN_RUNS:
        return None
    return skill.success_count / skill.total_runs


def _forged_tool_validator_status(conn: psycopg.Connection, skill_name: str) -> str | None:
    """Return the latest validator status for a forged tool, or None."""
    row = conn.execute(
        """
        SELECT status
        FROM forged_tool_validation_runs
        WHERE tool_name = %s
        ORDER BY run_at DESC
        LIMIT 1
        """,
        (skill_name,),
    ).fetchone()
    return row[0] if row else None


def _log_promotion_event(
    conn: psycopg.Connection, event: PromotionEvent
) -> None:
    conn.execute(
        """
        INSERT INTO skill_promotion_events
          (id, skill_name, version, event_type, reason, metadata)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (
            str(uuid.uuid4()),
            event.skill_name,
            event.version,
            event.event_type,
            event.reason,
            json.dumps(event.metadata),
        ),
    )


def _write_auto_demoted_feedback(
    conn: psycopg.Connection, skill: SkillRow
) -> None:
    conn.execute(
        """
        INSERT INTO feedback_events (id, user_entra_id, signal, query_text)
        VALUES (%s, %s, 'auto_demoted', %s)
        """,
        (
            str(uuid.uuid4()),
            skill.proposed_by_user_entra_id or "system",
            f"Skill '{skill.name}' v{skill.version} auto-demoted: "
            f"success rate {skill.success_count}/{skill.total_runs} < {DEMOTION_SUCCESS_RATE}",
        ),
    )


# ---------------------------------------------------------------------------
# Core pass
# ---------------------------------------------------------------------------

def run_promotion_pass(conn: psycopg.Connection) -> list[PromotionEvent]:
    """Run one full promotion/demotion pass. Returns list of events emitted."""
    rows = conn.execute(
        """
        SELECT id::text, name, version, kind, active,
               COALESCE(success_count, 0) AS success_count,
               COALESCE(total_runs, 0) AS total_runs,
               COALESCE(proposed_by_user_entra_id, 'system') AS proposed_by_user_entra_id
        FROM skill_library
        WHERE kind IN ('prompt', 'forged_tool')
        ORDER BY name, version
        """
    ).fetchall()

    skills = [
        SkillRow(
            id=r[0], name=r[1], version=r[2], kind=r[3], active=r[4],
            success_count=r[5], total_runs=r[6],
            proposed_by_user_entra_id=r[7],
        )
        for r in rows
    ]

    events: list[PromotionEvent] = []

    for skill in skills:
        rate = _success_rate(skill)
        if rate is None:
            logger.debug(
                "Skipping %s v%d: only %d runs (need %d)",
                skill.name, skill.version, skill.total_runs, MIN_RUNS,
            )
            continue

        if not skill.active:
            # Promotion check.
            if rate >= PROMOTION_SUCCESS_RATE:
                # Extra gate for forged tools: validator must be 'passing'.
                if skill.kind == "forged_tool":
                    vstatus = _forged_tool_validator_status(conn, skill.name)
                    if vstatus != "passing":
                        logger.info(
                            "Skipping promotion of forged_tool %s v%d: validator=%s",
                            skill.name, skill.version, vstatus,
                        )
                        continue

                conn.execute(
                    "UPDATE skill_library SET active=true WHERE id=%s",
                    (skill.id,),
                )
                ev = PromotionEvent(
                    skill_name=skill.name,
                    version=skill.version,
                    event_type="promote",
                    reason=(
                        f"success_rate={rate:.2f} >= {PROMOTION_SUCCESS_RATE} "
                        f"over {skill.total_runs} runs"
                    ),
                    metadata={
                        "success_rate": rate,
                        "total_runs": skill.total_runs,
                        "kind": skill.kind,
                    },
                )
                _log_promotion_event(conn, ev)
                events.append(ev)
                logger.info("Promoted %s v%d (rate=%.2f)", skill.name, skill.version, rate)

        else:
            # Demotion check.
            if rate < DEMOTION_SUCCESS_RATE:
                conn.execute(
                    "UPDATE skill_library SET active=false WHERE id=%s",
                    (skill.id,),
                )
                _write_auto_demoted_feedback(conn, skill)
                ev = PromotionEvent(
                    skill_name=skill.name,
                    version=skill.version,
                    event_type="demote",
                    reason=(
                        f"success_rate={rate:.2f} < {DEMOTION_SUCCESS_RATE} "
                        f"over {skill.total_runs} runs"
                    ),
                    metadata={
                        "success_rate": rate,
                        "total_runs": skill.total_runs,
                        "kind": skill.kind,
                    },
                )
                _log_promotion_event(conn, ev)
                events.append(ev)
                logger.info("Demoted %s v%d (rate=%.2f)", skill.name, skill.version, rate)

    conn.commit()
    return events


# ---------------------------------------------------------------------------
# Entry point for direct use / compose
# ---------------------------------------------------------------------------

def run_once() -> None:
    dsn = (
        f"host={os.environ.get('POSTGRES_HOST', 'localhost')} "
        f"port={os.environ.get('POSTGRES_PORT', '5432')} "
        f"dbname={os.environ.get('POSTGRES_DB', 'chemclaw')} "
        f"user={os.environ.get('POSTGRES_USER', 'chemclaw')} "
        f"password={os.environ.get('POSTGRES_PASSWORD', '')}"
    )
    with psycopg.connect(dsn) as conn:
        events = run_promotion_pass(conn)
    logger.info("Promotion pass complete — %d events", len(events))
