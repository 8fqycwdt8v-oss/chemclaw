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


# ---------------------------------------------------------------------------
# Prompt registry promotion / demotion (Phase E correction).
# ---------------------------------------------------------------------------
#
# GEPA inserts shadow candidates with active=false and shadow_until=NOW()+7d.
# When the window closes we either promote (atomic active flip + audit row)
# or reject (clear shadow_until + audit row) based on shadow_run_scores.

PROMPT_PROMOTION_FLOOR = 0.80
PROMPT_PROMOTION_DELTA = 0.05
PROMPT_PROMOTION_PER_CLASS_REGRESSION = 0.02


def _fetch_active_prompt_score(
    conn: psycopg.Connection, prompt_name: str
) -> tuple[float | None, dict[str, float] | None]:
    row = conn.execute(
        """
        SELECT version
          FROM prompt_registry
         WHERE prompt_name = %s AND active = TRUE
         LIMIT 1
        """,
        (prompt_name,),
    ).fetchone()
    if not row:
        return None, None
    active_version = row[0]
    score_row = conn.execute(
        """
        SELECT AVG(score)::float8 AS mean_score
          FROM shadow_run_scores
         WHERE prompt_name = %s AND version = %s
        """,
        (prompt_name, active_version),
    ).fetchone()
    mean = score_row[0] if score_row else None
    per_class_rows = conn.execute(
        """
        SELECT key, AVG(value::float8)
          FROM shadow_run_scores,
               jsonb_each_text(per_class_scores) AS kv(key, value)
         WHERE prompt_name = %s AND version = %s
           AND per_class_scores IS NOT NULL
         GROUP BY key
        """,
        (prompt_name, active_version),
    ).fetchall()
    per_class = {r[0]: float(r[1]) for r in per_class_rows} if per_class_rows else None
    return mean, per_class


def _evaluate_shadow_prompt(
    conn: psycopg.Connection,
    prompt_name: str,
    shadow_version: int,
    active_mean: float | None,
    active_per_class: dict[str, float] | None,
) -> tuple[bool, str, dict[str, Any]]:
    score_row = conn.execute(
        """
        SELECT AVG(score)::float8, COUNT(*)
          FROM shadow_run_scores
         WHERE prompt_name = %s AND version = %s
        """,
        (prompt_name, shadow_version),
    ).fetchone()
    if not score_row or score_row[1] == 0:
        return False, "no_shadow_runs_recorded", {"shadow_runs": 0}

    shadow_mean = float(score_row[0])
    shadow_runs = int(score_row[1])
    metadata: dict[str, Any] = {
        "shadow_mean_score": shadow_mean,
        "shadow_runs": shadow_runs,
        "active_mean_score": active_mean,
    }

    if shadow_mean < PROMPT_PROMOTION_FLOOR:
        return (
            False,
            f"shadow_mean={shadow_mean:.3f} < floor={PROMPT_PROMOTION_FLOOR}",
            metadata,
        )

    if active_mean is not None and shadow_mean < active_mean + PROMPT_PROMOTION_DELTA:
        return (
            False,
            f"shadow_mean={shadow_mean:.3f} < active_mean={active_mean:.3f}+{PROMPT_PROMOTION_DELTA}",
            metadata,
        )

    if active_per_class:
        per_class_rows = conn.execute(
            """
            SELECT key, AVG(value::float8)
              FROM shadow_run_scores,
                   jsonb_each_text(per_class_scores) AS kv(key, value)
             WHERE prompt_name = %s AND version = %s
               AND per_class_scores IS NOT NULL
             GROUP BY key
            """,
            (prompt_name, shadow_version),
        ).fetchall()
        shadow_per_class = {r[0]: float(r[1]) for r in per_class_rows}
        for cls, active_score in active_per_class.items():
            shadow_class_score = shadow_per_class.get(cls, active_score)
            drop = active_score - shadow_class_score
            if drop > PROMPT_PROMOTION_PER_CLASS_REGRESSION:
                return (
                    False,
                    f"class={cls} regressed by {drop:.3f} > {PROMPT_PROMOTION_PER_CLASS_REGRESSION}",
                    {**metadata, "regression_class": cls, "regression_drop": drop},
                )

    return (
        True,
        f"shadow_mean={shadow_mean:.3f} beats active by >= {PROMPT_PROMOTION_DELTA}",
        metadata,
    )


def run_prompt_promotion_pass(conn: psycopg.Connection) -> list[PromotionEvent]:
    """Promote (or reject) prompt_registry shadows whose shadow_until window
    has expired. Writes one skill_promotion_events row per outcome."""
    rows = conn.execute(
        """
        SELECT prompt_name, version
          FROM prompt_registry
         WHERE active = FALSE
           AND shadow_until IS NOT NULL
           AND shadow_until <= NOW()
         ORDER BY prompt_name, version
        """
    ).fetchall()

    events: list[PromotionEvent] = []
    for prompt_name, version in rows:
        active_mean, active_per_class = _fetch_active_prompt_score(conn, prompt_name)
        promote, reason, metadata = _evaluate_shadow_prompt(
            conn, prompt_name, version, active_mean, active_per_class
        )

        if promote:
            conn.execute(
                """
                UPDATE prompt_registry
                   SET active = FALSE
                 WHERE prompt_name = %s AND active = TRUE
                """,
                (prompt_name,),
            )
            conn.execute(
                """
                UPDATE prompt_registry
                   SET active = TRUE,
                       shadow_until = NULL
                 WHERE prompt_name = %s AND version = %s
                """,
                (prompt_name, version),
            )
            ev = PromotionEvent(
                skill_name=prompt_name,
                version=version,
                event_type="shadow_promote",
                reason=reason,
                metadata={**metadata, "kind": "prompt"},
            )
            _log_promotion_event(conn, ev)
            events.append(ev)
            logger.info("Promoted prompt %s v%d (%s)", prompt_name, version, reason)
        else:
            conn.execute(
                """
                UPDATE prompt_registry
                   SET shadow_until = NULL
                 WHERE prompt_name = %s AND version = %s
                """,
                (prompt_name, version),
            )
            ev = PromotionEvent(
                skill_name=prompt_name,
                version=version,
                event_type="shadow_reject",
                reason=reason,
                metadata={**metadata, "kind": "prompt"},
            )
            _log_promotion_event(conn, ev)
            events.append(ev)
            logger.info("Rejected prompt %s v%d (%s)", prompt_name, version, reason)

    conn.commit()
    return events
