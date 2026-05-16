"""hypothesis_former — auto-hypothesis formation from anomalies + patterns (Phase 4).

Subscribes to `anomaly_observed` and `pattern_detected` events. For each:

  1. Budget-gate: check investigation_budget_usage daily LLM spend.
  2. Hypothesis cap: count active HYPOTHESIZED facts for the project; skip if
     >= max_active_hypotheses_per_project (default 12 per config_settings).
  3. Gather context:
     - anomaly_observed: fetch the anomalous fact + 10 peer facts for context.
     - pattern_detected: use the cluster summary directly from payload.
  4. Load the `hypothesis.form` prompt from prompt_registry (built-in fallback).
  5. Call LiteLLM. Response: JSON list of
       {predicate, subject_label, subject_id_value, hypothesis_text,
        confidence, supporting_fact_ids?}
  6. INSERT each into `facts` with derivation_class=HYPOTHESIZED,
     derivation_depth=2 (always; hypotheses are second-order inferences).
  7. Emit `hypothesis_proposed` ingestion event per new fact (consumed by
     kg_hypotheses projector and wiki_regen).

Confidence cap: HYPOTHESIZED facts cannot exceed 0.65 (high tier; they haven't
been tested). test_planner (Phase 5) will design experiments to confirm/refute.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

import httpx
import psycopg
from psycopg.rows import dict_row
from pydantic_settings import BaseSettings, SettingsConfigDict

from services.mcp_tools.common.logging import configure_logging
from services.projectors.common.base import BaseProjector, ProjectorSettings
from services.projectors.fact_extractor._common import confidence_tier

log = logging.getLogger("projector.hypothesis_former")

_MAX_HYPOTHESIS_CONFIDENCE = 0.65
_HYPOTHESIS_DERIVATION_DEPTH = 2
_MAX_CONTEXT_PEER_FACTS = 10

_FALLBACK_PROMPT = """\
You are an expert pharmaceutical chemist formulating scientific hypotheses.
Given an anomalous measurement or a cross-compound statistical pattern, propose
testable HYPOTHESIZED claims that could explain the observation.

Return a JSON array — and ONLY that array, no preamble. Each element:
{
  "predicate": "<snake_case_hypothesis, e.g. mechanism_involves_pi_stacking>",
  "subject_label": "Compound" | "NCEProject" | "Reaction" | "OptimizationCampaign",
  "subject_id_value": "<identifier>",
  "hypothesis_text": "<one-sentence scientific hypothesis, falsifiable>",
  "object_value": {"value": "<brief claim or true/false>"},
  "confidence": <0.20–0.65>,
  "supporting_fact_ids": []
}

Rules:
- Hypotheses must be falsifiable and specific to the supplied evidence.
- Do not invent compound names, identifiers, or measurements.
- Confidence 0.50–0.65: well-supported by evidence. 0.30–0.49: plausible but
  requires confirmation. 0.20–0.29: speculative.
- If you cannot form a meaningful hypothesis from the context, return [].
"""


class HypothesisFormerSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_db: str = "chemclaw"
    postgres_user: str = "chemclaw_service"
    postgres_password: str = ""

    litellm_base_url: str = "http://litellm:4000"
    litellm_api_key: str = "sk-chemclaw-dev-master-change-me"
    hypothesis_former_model: str = "claude-haiku-4-5"
    hypothesis_former_max_tokens: int = 2048
    hypothesis_former_daily_llm_budget_usd: float = 50.0
    hypothesis_former_max_active_per_project: int = 12
    projector_log_level: str = "INFO"

    @property
    def postgres_dsn(self) -> str:
        return (
            f"host={self.postgres_host} port={self.postgres_port} "
            f"dbname={self.postgres_db} user={self.postgres_user} "
            f"password={self.postgres_password}"
        )


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


async def _check_daily_budget(
    conn: psycopg.AsyncConnection[dict[str, Any]], budget_usd: float
) -> bool:
    today = datetime.now(timezone.utc).date().isoformat()
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT COALESCE(SUM(llm_usd_spent), 0) AS spent "
            "FROM investigation_budget_usage WHERE scope = 'global' AND date_utc = %s",
            (today,),
        )
        row = await cur.fetchone()
    spent = float((row.get("spent") if isinstance(row, dict) else row[0]) or 0)
    return spent < budget_usd


async def _record_llm_spend(
    conn: psycopg.AsyncConnection[dict[str, Any]], usd: float
) -> None:
    today = datetime.now(timezone.utc).date().isoformat()
    async with conn.cursor() as cur:
        await cur.execute(
            "INSERT INTO investigation_budget_usage (scope, scope_id, date_utc, llm_usd_spent) "
            "VALUES ('global', '', %s, %s) "
            "ON CONFLICT (scope, scope_id, date_utc) "
            "DO UPDATE SET llm_usd_spent = investigation_budget_usage.llm_usd_spent + EXCLUDED.llm_usd_spent",
            (today, usd),
        )


async def _count_active_hypotheses(
    conn: psycopg.AsyncConnection[dict[str, Any]], project_id: str | None
) -> int:
    async with conn.cursor() as cur:
        if project_id:
            await cur.execute(
                "SELECT count(*) AS n FROM facts "
                "WHERE derivation_class = 'HYPOTHESIZED' AND project_id = %s::uuid",
                (project_id,),
            )
        else:
            await cur.execute(
                "SELECT count(*) AS n FROM facts WHERE derivation_class = 'HYPOTHESIZED'"
            )
        row = await cur.fetchone()
    return int((row.get("n") if isinstance(row, dict) else row[0]) or 0)


async def _fetch_fact(
    conn: psycopg.AsyncConnection[dict[str, Any]], fact_id: str
) -> dict[str, Any] | None:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT id::text AS id, subject_label, subject_id_value, predicate, "
            "       object_value, unit, project_id::text AS project_id, confidence "
            "FROM facts WHERE id = %s::uuid",
            (fact_id,),
        )
        return await cur.fetchone()


async def _fetch_peer_facts(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    predicate: str,
    subject_label: str,
    exclude_id: str,
) -> list[dict[str, Any]]:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT id::text AS id, subject_id_value, object_value, unit, confidence "
            "FROM facts WHERE predicate = %s AND subject_label = %s AND id != %s::uuid "
            "ORDER BY confidence DESC LIMIT %s",
            (predicate, subject_label, exclude_id, _MAX_CONTEXT_PEER_FACTS),
        )
        return list(await cur.fetchall())


async def _load_prompt(conn: psycopg.AsyncConnection[dict[str, Any]]) -> str:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT template FROM prompt_registry "
            "WHERE prompt_name = %s AND active ORDER BY version DESC LIMIT 1",
            ("hypothesis.form",),
        )
        row = await cur.fetchone()
    if row is not None:
        tmpl = (row.get("template") if isinstance(row, dict) else row[0]) or ""
        if isinstance(tmpl, str) and tmpl.strip():
            return tmpl
    return _FALLBACK_PROMPT


async def _insert_hypothesis(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    raw: dict[str, Any],
    project_id: str | None,
    confidence: float,
    source_fact_id: str | None,
) -> str | None:
    tier = confidence_tier(confidence)
    supporting = raw.get("supporting_fact_ids") or []
    if source_fact_id and source_fact_id not in supporting:
        supporting = [source_fact_id, *list(supporting)]

    obj_value = raw.get("object_value") or {"value": raw.get("hypothesis_text", "")}

    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO facts (
              project_id, subject_label, subject_id_value, predicate,
              object_value, polarity, derivation_class, confidence,
              confidence_tier, source_table, source_row_id,
              source_fact_ids, extractor_name, derivation_depth
            ) VALUES (
              %s::uuid, %s, %s, %s,
              %s::jsonb, 'positive', 'HYPOTHESIZED', %s,
              %s, 'facts', %s, %s, 'hypothesis_former', %s
            )
            ON CONFLICT DO NOTHING
            RETURNING id::text
            """,
            (
                project_id,
                str(raw.get("subject_label", "Compound")),
                str(raw.get("subject_id_value", "unknown")),
                str(raw.get("predicate", "")),
                json.dumps(obj_value),
                float(confidence),
                tier,
                source_fact_id,
                supporting,
                _HYPOTHESIS_DERIVATION_DEPTH,
            ),
        )
        row = await cur.fetchone()
    return str(row.get("id") if isinstance(row, dict) else row[0]) if row else None


async def _emit_hypothesis_proposed(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    fact_id: str,
    predicate: str,
) -> None:
    async with conn.cursor() as cur:
        await cur.execute(
            "INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload) "
            "VALUES ('hypothesis_proposed', 'facts', %s, "
            "        jsonb_build_object('fact_id', %s::text, 'predicate', %s::text, "
            "                           'extractor', 'hypothesis_former'))",
            (fact_id, fact_id, predicate),
        )


# ---------------------------------------------------------------------------
# LLM helpers
# ---------------------------------------------------------------------------


async def _call_llm(
    client: httpx.AsyncClient,
    settings: HypothesisFormerSettings,
    system_prompt: str,
    user_content: str,
) -> list[dict[str, Any]]:
    try:
        r = await client.post(
            f"{settings.litellm_base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {settings.litellm_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": settings.hypothesis_former_model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
                "max_tokens": settings.hypothesis_former_max_tokens,
                "temperature": 0.2,
            },
        )
    except httpx.HTTPError as exc:
        log.warning("hypothesis_former LiteLLM network error: %s", exc)
        return []

    if r.status_code >= 400:
        log.warning("hypothesis_former LiteLLM %s: %.200s", r.status_code, r.text)
        return []

    try:
        choices = r.json().get("choices") or [{}]
        content = ((choices[0] or {}).get("message", {}).get("content", "") or "").strip()
    except Exception as exc:  # noqa: BLE001
        log.warning("hypothesis_former: failed to parse LiteLLM response: %s", exc)
        return []

    if content.startswith("```"):
        content = content.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        log.warning("hypothesis_former: LLM returned non-JSON: %s — %.100s", exc, content)
        return []

    return parsed if isinstance(parsed, list) else []


# ---------------------------------------------------------------------------
# Projector
# ---------------------------------------------------------------------------


class HypothesisFormer(BaseProjector):
    """Projector: anomaly_observed + pattern_detected → HYPOTHESIZED facts."""

    name = "hypothesis_former"
    interested_event_types = ("anomaly_observed", "pattern_detected")

    def __init__(
        self, settings: ProjectorSettings, hyp_settings: HypothesisFormerSettings
    ) -> None:
        super().__init__(settings)
        self._cfg = hyp_settings

    async def handle(
        self,
        *,
        event_id: str,
        event_type: str,
        source_table: str | None,  # noqa: ARG002
        source_row_id: str | None,
        payload: dict[str, Any],
    ) -> None:
        async with await psycopg.AsyncConnection.connect(
            self.settings.postgres_dsn, row_factory=dict_row
        ) as conn:
            if event_type == "anomaly_observed":
                fact_id = payload.get("fact_id") or source_row_id
                if not fact_id:
                    log.warning("hypothesis_former: anomaly_observed %s missing fact_id", event_id)
                    return
                await self._form_from_anomaly(conn, str(fact_id), payload)
            elif event_type == "pattern_detected":
                await self._form_from_pattern(conn, payload)
            await conn.commit()

    async def _form_from_anomaly(
        self,
        conn: psycopg.AsyncConnection[dict[str, Any]],
        fact_id: str,
        payload: dict[str, Any],
    ) -> None:
        if not await _check_daily_budget(conn, self._cfg.hypothesis_former_daily_llm_budget_usd):
            log.info("hypothesis_former: daily LLM budget exhausted; skipping anomaly %s", fact_id)
            return

        source_fact = await _fetch_fact(conn, fact_id)
        if not source_fact:
            return

        project_id: str | None = source_fact.get("project_id")

        n_active = await _count_active_hypotheses(conn, project_id)
        if n_active >= self._cfg.hypothesis_former_max_active_per_project:
            log.debug(
                "hypothesis_former: project %s at hypothesis cap (%d); skipping",
                project_id, n_active,
            )
            return

        predicate = str(source_fact.get("predicate", "") or "")
        subject_label = str(source_fact.get("subject_label", "") or "")
        peer_facts = await _fetch_peer_facts(conn, predicate, subject_label, fact_id)
        prompt = await _load_prompt(conn)

        def _r(row: Any) -> dict[str, Any]:
            return row if isinstance(row, dict) else {}

        user_content = json.dumps(
            {
                "trigger": "anomaly_observed",
                "anomaly_score": payload.get("anomaly_score"),
                "source_fact": {
                    "id": source_fact.get("id"),
                    "subject_label": subject_label,
                    "subject_id_value": str(source_fact.get("subject_id_value", "")),
                    "predicate": predicate,
                    "object_value": source_fact.get("object_value"),
                    "unit": source_fact.get("unit"),
                    "confidence": source_fact.get("confidence"),
                },
                "peer_facts": [
                    {"subject_id_value": _r(r).get("subject_id_value"),
                     "object_value": _r(r).get("object_value"),
                     "confidence": _r(r).get("confidence")}
                    for r in peer_facts
                ],
            },
            default=str,
        )[:40000]

        await self._llm_and_insert(conn, prompt, user_content, source_fact_id=fact_id, project_id=project_id)

    async def _form_from_pattern(
        self,
        conn: psycopg.AsyncConnection[dict[str, Any]],
        payload: dict[str, Any],
    ) -> None:
        if not await _check_daily_budget(conn, self._cfg.hypothesis_former_daily_llm_budget_usd):
            log.info("hypothesis_former: daily LLM budget exhausted; skipping pattern")
            return

        n_active = await _count_active_hypotheses(conn, None)
        if n_active >= self._cfg.hypothesis_former_max_active_per_project * 3:
            log.debug("hypothesis_former: global hypothesis cap reached; skipping pattern")
            return

        prompt = await _load_prompt(conn)
        user_content = json.dumps(
            {"trigger": "pattern_detected", "pattern": payload},
            default=str,
        )[:40000]

        await self._llm_and_insert(conn, prompt, user_content, source_fact_id=None, project_id=None)

    async def _llm_and_insert(
        self,
        conn: psycopg.AsyncConnection[dict[str, Any]],
        prompt: str,
        user_content: str,
        source_fact_id: str | None,
        project_id: str | None,
    ) -> None:
        async with httpx.AsyncClient(timeout=60.0) as client:
            raw_hypotheses = await _call_llm(client, self._cfg, prompt, user_content)

        await _record_llm_spend(conn, 0.0005)

        inserted = 0
        for raw in raw_hypotheses:
            if not isinstance(raw, dict):
                continue
            pred = raw.get("predicate")
            if not isinstance(pred, str) or not pred:
                continue
            try:
                conf = min(float(raw.get("confidence") or 0.30), _MAX_HYPOTHESIS_CONFIDENCE)
            except (TypeError, ValueError):
                conf = 0.30
            if conf <= 0.0:
                continue

            new_id = await _insert_hypothesis(conn, raw, project_id, conf, source_fact_id)
            if new_id:
                await _emit_hypothesis_proposed(conn, new_id, str(pred))
                inserted += 1

        log.info(
            "hypothesis_former: source=%s inserted %d HYPOTHESIZED facts",
            source_fact_id or "pattern", inserted,
        )


def main() -> None:  # pragma: no cover
    base_settings = ProjectorSettings()
    hyp_settings = HypothesisFormerSettings()
    configure_logging(base_settings.projector_log_level)
    asyncio.run(HypothesisFormer(base_settings, hyp_settings).run())


if __name__ == "__main__":  # pragma: no cover
    main()
