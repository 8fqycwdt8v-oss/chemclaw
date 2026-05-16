"""investigation_scorer — novelty + anomaly + priority scoring projector (Phase 3).

Subscribes to `extracted_fact` events. For each new fact:

  1. Fetch the fact row from `facts` (predicate, object_value, project_id).
  2. Compute three independent signals (all in [0, 1]):
       novelty_score   — 1 / (1 + existing_fact_count) for same predicate+subject.
       anomaly_score   — |z-score| / 3.0 clamped to [0, 1] for numeric object_value.value;
                         0.0 if non-numeric or < 3 peers.
       priority_score  — 1.0 if project has an active synthesis campaign or
                         is in Phase 1/2; 0.0 if project exists but quiet; 0.5 if no project.
  3. Composite = anomaly_w * anomaly + novelty_w * novelty + priority_w * priority.
     Weights read from config_settings (defaults: 0.45 / 0.35 / 0.20).
  4. If composite == 0.0 → skip (fact is known + unremarkable + low-priority).
  5. If anomaly_score >= 0.70 → emit `anomaly_observed` (interpreted by hypothesis_former
     regardless of composite score).
  6. If composite >= score_threshold_sync (default 0.70) → emit `investigation_requested`
     (interpreter picks it up immediately).
  7. Elif composite >= 0.20 → INSERT into `investigation_queue` for the periodic sweep.
"""

from __future__ import annotations

import asyncio
import logging
import math
import statistics
from typing import Any

import psycopg
from psycopg.rows import dict_row
from pydantic_settings import BaseSettings, SettingsConfigDict

from services.mcp_tools.common.logging import configure_logging
from services.projectors.common.base import BaseProjector, ProjectorSettings

log = logging.getLogger("projector.investigation_scorer")

# Defaults mirror db/seed/09_universal_extraction_config.sql
_DEFAULT_ANOMALY_WEIGHT = 0.45
_DEFAULT_NOVELTY_WEIGHT = 0.35
_DEFAULT_PRIORITY_WEIGHT = 0.20
_DEFAULT_THRESHOLD_SYNC = 0.70
_DEFAULT_ANOMALY_EMIT_THRESHOLD = 0.70
_DEFAULT_MIN_QUEUE_SCORE = 0.20
_MIN_PEERS_FOR_ZSCORE = 3


class InvestigationScorerSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_db: str = "chemclaw"
    postgres_user: str = "chemclaw_service"
    postgres_password: str = ""
    projector_log_level: str = "INFO"

    # Mirrors config_settings — can be overridden via env for local dev.
    score_anomaly_weight: float = _DEFAULT_ANOMALY_WEIGHT
    score_novelty_weight: float = _DEFAULT_NOVELTY_WEIGHT
    score_priority_weight: float = _DEFAULT_PRIORITY_WEIGHT
    score_threshold_sync: float = _DEFAULT_THRESHOLD_SYNC

    @property
    def postgres_dsn(self) -> str:
        return (
            f"host={self.postgres_host} port={self.postgres_port} "
            f"dbname={self.postgres_db} user={self.postgres_user} "
            f"password={self.postgres_password}"
        )


# ---------------------------------------------------------------------------
# Pure scoring functions (no DB, easy to unit-test)
# ---------------------------------------------------------------------------


def compute_novelty_score(existing_count: int) -> float:
    """1 / (1 + n). Returns 1.0 for brand-new predicate+subject combos."""
    return 1.0 / (1.0 + max(0, existing_count))


def compute_anomaly_score(new_value: float, peer_values: list[float]) -> float:
    """z-score of new_value against peers, clamped to [0, 1] via z/3."""
    if len(peer_values) < _MIN_PEERS_FOR_ZSCORE:
        return 0.0
    try:
        mean = statistics.mean(peer_values)
        stdev = statistics.stdev(peer_values)
    except statistics.StatisticsError:
        return 0.0
    if stdev == 0.0:
        return 0.0
    z = abs(new_value - mean) / stdev
    return min(z / 3.0, 1.0)


def compute_priority_score(
    has_active_campaign: bool,
    is_clinical_phase: bool,
    has_project: bool,
) -> float:
    """1.0 → active campaign or clinical phase; 0.0 → project exists but quiet; 0.5 → no project (unknown priority)."""
    if not has_project:
        return 0.5
    if has_active_campaign or is_clinical_phase:
        return 1.0
    return 0.0


def compute_composite(
    novelty: float,
    anomaly: float,
    priority: float,
    weights: tuple[float, float, float],
) -> float:
    aw, nw, pw = weights
    total_w = aw + nw + pw or 1.0
    return (aw * anomaly + nw * novelty + pw * priority) / total_w


def reason_codes(
    novelty: float,
    anomaly: float,
    priority: float,
    composite: float,
    threshold_sync: float,
) -> list[str]:
    codes: list[str] = []
    if novelty >= 0.80:
        codes.append("novelty:new")
    elif novelty >= 0.40:
        codes.append("novelty:rare")
    else:
        codes.append("novelty:known")
    if anomaly >= _DEFAULT_ANOMALY_EMIT_THRESHOLD:
        codes.append("anomaly:outlier")
    elif anomaly >= 0.30:
        codes.append("anomaly:elevated")
    if priority >= 0.80:
        codes.append("priority:active")
    if composite >= threshold_sync:
        codes.append("routed:sync")
    return codes or ["score:low"]


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


async def _fetch_fact(
    conn: psycopg.AsyncConnection[dict[str, Any]], fact_id: str
) -> dict[str, Any] | None:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT id::text AS id, subject_label, subject_id_value, predicate, "
            "       object_value, project_id::text AS project_id, confidence "
            "FROM facts WHERE id = %s::uuid",
            (fact_id,),
        )
        return await cur.fetchone()


async def _count_peer_facts(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    predicate: str,
    subject_label: str,
    exclude_id: str,
) -> int:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT count(*) AS n FROM facts "
            "WHERE predicate = %s AND subject_label = %s AND id != %s::uuid",
            (predicate, subject_label, exclude_id),
        )
        row = await cur.fetchone()
    if row is None:
        return 0
    return int(row.get("n") if isinstance(row, dict) else row[0])


async def _fetch_peer_numeric_values(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    predicate: str,
    subject_label: str,
    exclude_id: str,
) -> list[float]:
    """Return numeric .value from object_value for peer facts."""
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT (object_value->>'value')::float AS v FROM facts "
            "WHERE predicate = %s AND subject_label = %s AND id != %s::uuid "
            "  AND object_value ? 'value' "
            "  AND jsonb_typeof(object_value->'value') = 'number' "
            "LIMIT 200",
            (predicate, subject_label, exclude_id),
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


async def _check_project_priority(
    conn: psycopg.AsyncConnection[dict[str, Any]], project_id: str | None
) -> tuple[bool, bool, bool]:
    """Return (has_active_campaign, is_clinical_phase, has_project)."""
    if not project_id:
        return False, False, False

    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT phase FROM nce_projects WHERE id = %s::uuid",
            (project_id,),
        )
        proj = await cur.fetchone()

    if proj is None:
        return False, False, True

    phase = (proj.get("phase") if isinstance(proj, dict) else proj[0]) or ""
    is_clinical = any(kw in str(phase).lower() for kw in ("phase 1", "phase 2", "phase i", "phase ii"))

    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM synthesis_campaigns WHERE nce_project_id = %s::uuid AND status = 'active' LIMIT 1",
            (project_id,),
        )
        active_row = await cur.fetchone()

    return active_row is not None, is_clinical, True


async def _emit_event(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    event_type: str,
    fact_id: str,
    payload: dict[str, Any],
) -> None:
    async with conn.cursor() as cur:
        await cur.execute(
            "INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload) "
            "VALUES (%s, 'facts', %s, %s::jsonb)",
            (event_type, fact_id, __import__("json").dumps(payload)),
        )


async def _enqueue_investigation(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    fact_id: str,
    project_id: str | None,
    score: float,
    codes: list[str],
) -> None:
    async with conn.cursor() as cur:
        await cur.execute(
            "INSERT INTO investigation_queue (fact_id, project_id, score, reason_codes) "
            "VALUES (%s::uuid, %s::uuid, %s, %s) "
            "ON CONFLICT (fact_id) WHERE picked_at IS NULL DO NOTHING",
            (fact_id, project_id, round(score, 3), codes),
        )


# ---------------------------------------------------------------------------
# Projector
# ---------------------------------------------------------------------------


class InvestigationScorer(BaseProjector):
    """Projector: extracted_fact → novelty/anomaly/priority score → route."""

    name = "investigation_scorer"
    interested_event_types = ("extracted_fact",)

    def __init__(
        self, settings: ProjectorSettings, scorer_settings: InvestigationScorerSettings
    ) -> None:
        super().__init__(settings)
        self._cfg = scorer_settings

    async def handle(
        self,
        *,
        event_id: str,
        event_type: str,  # noqa: ARG002
        source_table: str | None,  # noqa: ARG002
        source_row_id: str | None,
        payload: dict[str, Any],
    ) -> None:
        fact_id = payload.get("fact_id") or source_row_id
        if not fact_id:
            log.warning("investigation_scorer: event %s has no fact_id; skipping", event_id)
            return

        async with await psycopg.AsyncConnection.connect(
            self.settings.postgres_dsn, row_factory=dict_row
        ) as conn:
            await self._score_and_route(conn, str(fact_id))
            await conn.commit()

    async def _score_and_route(
        self,
        conn: psycopg.AsyncConnection[dict[str, Any]],
        fact_id: str,
    ) -> None:
        fact = await _fetch_fact(conn, fact_id)
        if fact is None:
            log.warning("investigation_scorer: fact %s not found", fact_id)
            return

        predicate = str(fact.get("predicate", "") or "")
        subject_label = str(fact.get("subject_label", "") or "")
        project_id: str | None = fact.get("project_id")

        # --- novelty --------------------------------------------------------
        existing_count = await _count_peer_facts(conn, predicate, subject_label, fact_id)
        novelty = compute_novelty_score(existing_count)

        # --- anomaly (numeric only) -----------------------------------------
        obj = fact.get("object_value") or {}
        raw_value = obj.get("value") if isinstance(obj, dict) else None
        anomaly = 0.0
        if raw_value is not None:
            try:
                numeric_val = float(raw_value)
                peers = await _fetch_peer_numeric_values(conn, predicate, subject_label, fact_id)
                anomaly = compute_anomaly_score(numeric_val, peers)
            except (TypeError, ValueError):
                pass

        # --- priority -------------------------------------------------------
        has_active, is_clinical, has_project = await _check_project_priority(conn, project_id)
        priority = compute_priority_score(has_active, is_clinical, has_project)

        # --- composite -------------------------------------------------------
        weights = (self._cfg.score_anomaly_weight, self._cfg.score_novelty_weight, self._cfg.score_priority_weight)
        composite = compute_composite(novelty, anomaly, priority, weights)

        codes = reason_codes(novelty, anomaly, priority, composite, self._cfg.score_threshold_sync)

        log.debug(
            "fact=%s predicate=%s novelty=%.2f anomaly=%.2f priority=%.2f composite=%.2f",
            fact_id, predicate, novelty, anomaly, priority, composite,
        )

        if composite == 0.0:
            return

        # --- emit anomaly_observed when strongly anomalous ------------------
        if anomaly >= _DEFAULT_ANOMALY_EMIT_THRESHOLD:
            await _emit_event(conn, "anomaly_observed", fact_id, {
                "fact_id": fact_id,
                "predicate": predicate,
                "anomaly_score": round(anomaly, 3),
                "reason_codes": codes,
            })
            log.info("investigation_scorer: anomaly_observed fact=%s anomaly=%.3f", fact_id, anomaly)

        # --- route high-scorers to sync interpretation ----------------------
        if composite >= self._cfg.score_threshold_sync:
            await _emit_event(conn, "investigation_requested", fact_id, {
                "fact_id": fact_id,
                "predicate": predicate,
                "composite_score": round(composite, 3),
                "reason_codes": codes,
            })
            log.info(
                "investigation_scorer: investigation_requested fact=%s composite=%.3f",
                fact_id, composite,
            )
            return

        # --- queue lower-scorers for deferred sweep -------------------------
        if composite >= _DEFAULT_MIN_QUEUE_SCORE:
            await _enqueue_investigation(conn, fact_id, project_id, composite, codes)
            log.debug("investigation_scorer: queued fact=%s score=%.3f", fact_id, composite)


def main() -> None:  # pragma: no cover
    base_settings = ProjectorSettings()
    scorer_settings = InvestigationScorerSettings()
    configure_logging(base_settings.projector_log_level)
    asyncio.run(InvestigationScorer(base_settings, scorer_settings).run())


if __name__ == "__main__":  # pragma: no cover
    main()
