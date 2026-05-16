"""interpreter — LLM-driven INTERPRETED fact derivation projector (Phase 3).

Subscribes to `investigation_requested` events. For each event:

  1. Fetch the source fact from `facts`.
  2. Budget-gate: check investigation_budget_usage for today's LLM spend.
  3. Gather KG context: peer facts for the same predicate + subject, plus
     nearby facts (same subject, any predicate, top-5 by confidence).
  4. Load the `fact_interpretation.derive` prompt from prompt_registry
     (built-in fallback if missing).
  5. Call LiteLLM. Response: JSON list of
       {predicate, object_value, unit?, confidence, reasoning}
  6. Validate: derivation_depth <= max_derivation_depth; confidence <= 0.75
     (INTERPRETED facts can't exceed high tier without corroboration).
  7. INSERT each derived fact into `facts` with derivation_class=INTERPRETED,
     derivation_depth = source_depth + 1, source_fact_ids=[source_fact_id].
  8. Emit `interpretation_proposed` ingestion event per new fact.

All LLM traffic goes through the central LiteLLM endpoint (single egress chokepoint).
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, timezone
from typing import Any

import httpx
import psycopg
from psycopg.rows import dict_row
from pydantic_settings import BaseSettings, SettingsConfigDict

from services.mcp_tools.common.logging import configure_logging
from services.projectors.common.base import BaseProjector, ProjectorSettings
from services.projectors.fact_extractor._common import confidence_tier

log = logging.getLogger("projector.interpreter")

_MAX_INTERPRETED_CONFIDENCE = 0.75
_MAX_DERIVATION_DEPTH = 4  # mirrors investigation.max_derivation_depth default
_CONTEXT_PEER_LIMIT = 20
_CONTEXT_SUBJECT_LIMIT = 10

_FALLBACK_PROMPT = """\
You are an expert pharmaceutical chemist reasoning over structured facts from a
knowledge graph. Given a source fact and related context facts, derive new
INTERPRETED claims that follow logically from the evidence.

Return a JSON array — and ONLY that array, no preamble. Each element:
{
  "predicate": "<snake_case_claim, e.g. suggests_high_reactivity>",
  "object_value": {"value": <number or string>},
  "unit": "<SI unit or null>",
  "confidence": <0.0–0.75>,
  "reasoning": "<one sentence explaining the inference>"
}

Rules:
- Only derive claims directly supported by the provided facts.
- Do not invent identifiers, compound names, or measurement values.
- Use confidence 0.65–0.75 for strong logical inference; 0.40–0.64 for
  plausible but uncertain; 0.20–0.39 for speculative.
- subject_label and subject_id_value will be inherited from the source fact.
- If no interpretation is warranted, return [].
"""


class InterpreterSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_db: str = "chemclaw"
    postgres_user: str = "chemclaw_service"
    postgres_password: str = ""

    litellm_base_url: str = "http://litellm:4000"
    litellm_api_key: str = "sk-chemclaw-dev-master-change-me"
    interpreter_model: str = "claude-haiku-4-5"
    interpreter_max_tokens: int = 2048
    interpreter_max_derivation_depth: int = _MAX_DERIVATION_DEPTH
    interpreter_daily_llm_budget_usd: float = 50.0
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


async def _fetch_fact(
    conn: psycopg.AsyncConnection[dict[str, Any]], fact_id: str
) -> dict[str, Any] | None:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT id::text AS id, subject_label, subject_id_value, predicate, "
            "       object_value, unit, project_id::text AS project_id, "
            "       confidence, confidence_tier, derivation_depth, derivation_class "
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
            "SELECT id::text AS id, object_value, unit, confidence, derivation_class "
            "FROM facts "
            "WHERE predicate = %s AND subject_label = %s AND id != %s::uuid "
            "ORDER BY confidence DESC LIMIT %s",
            (predicate, subject_label, exclude_id, _CONTEXT_PEER_LIMIT),
        )
        return list(await cur.fetchall())


async def _fetch_subject_facts(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    subject_id_value: str,
    exclude_id: str,
) -> list[dict[str, Any]]:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT id::text AS id, predicate, object_value, unit, confidence "
            "FROM facts "
            "WHERE subject_id_value = %s AND id != %s::uuid "
            "ORDER BY confidence DESC LIMIT %s",
            (subject_id_value, exclude_id, _CONTEXT_SUBJECT_LIMIT),
        )
        return list(await cur.fetchall())


async def _load_prompt(conn: psycopg.AsyncConnection[dict[str, Any]]) -> str:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT template FROM prompt_registry "
            "WHERE prompt_name = %s AND active ORDER BY version DESC LIMIT 1",
            ("fact_interpretation.derive",),
        )
        row = await cur.fetchone()
    if row is not None:
        tmpl = (row.get("template") if isinstance(row, dict) else row[0]) or ""
        if isinstance(tmpl, str) and tmpl.strip():
            return tmpl
    return _FALLBACK_PROMPT


async def _check_daily_budget(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    budget_usd: float,
) -> bool:
    """Return True if daily LLM budget has not been exhausted."""
    today = date.today().isoformat()
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT COALESCE(SUM(llm_usd_spent), 0) AS spent "
            "FROM investigation_budget_usage "
            "WHERE scope = 'global' AND date_utc = %s",
            (today,),
        )
        row = await cur.fetchone()
    spent = float((row.get("spent") if isinstance(row, dict) else row[0]) or 0)
    return spent < budget_usd


async def _record_llm_spend(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    usd: float,
) -> None:
    today = date.today().isoformat()
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO investigation_budget_usage
              (scope, scope_id, date_utc, llm_usd_spent)
            VALUES ('global', '', %s, %s)
            ON CONFLICT (scope, scope_id, date_utc)
            DO UPDATE SET llm_usd_spent = investigation_budget_usage.llm_usd_spent + EXCLUDED.llm_usd_spent
            """,
            (today, usd),
        )


async def _insert_interpreted_fact(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    source_fact: dict[str, Any],
    predicate: str,
    object_value: Any,
    unit: str | None,
    confidence: float,
    derivation_depth: int,
) -> str | None:
    tier = confidence_tier(confidence)
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO facts (
              project_id, subject_label, subject_id_value, predicate,
              object_value, unit, polarity, derivation_class, confidence,
              confidence_tier, source_table, source_row_id,
              source_fact_ids, extractor_name, derivation_depth
            ) VALUES (
              %s::uuid, %s, %s, %s,
              %s::jsonb, %s, 'positive', 'INTERPRETED', %s,
              %s, 'facts', %s,
              %s, 'interpreter', %s
            )
            ON CONFLICT DO NOTHING
            RETURNING id::text
            """,
            (
                source_fact.get("project_id"),
                str(source_fact.get("subject_label", "")),
                str(source_fact.get("subject_id_value", "")),
                predicate,
                json.dumps(object_value) if object_value is not None else "{}",
                unit,
                float(confidence),
                tier,
                str(source_fact.get("id", "")),
                [source_fact.get("id", "")],
                derivation_depth,
            ),
        )
        row = await cur.fetchone()
    if row is None:
        return None
    return str(row.get("id") if isinstance(row, dict) else row[0])


async def _emit_interpretation_event(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    fact_id: str,
    source_fact_id: str,
    predicate: str,
) -> None:
    async with conn.cursor() as cur:
        await cur.execute(
            "INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload) "
            "VALUES ('interpretation_proposed', 'facts', %s, "
            "        jsonb_build_object('fact_id', %s::text, 'source_fact_id', %s::text, "
            "                           'predicate', %s::text, 'extractor', 'interpreter'))",
            (fact_id, fact_id, source_fact_id, predicate),
        )


# ---------------------------------------------------------------------------
# LLM call
# ---------------------------------------------------------------------------


async def _call_llm(
    client: httpx.AsyncClient,
    settings: InterpreterSettings,
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
                "model": settings.interpreter_model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
                "max_tokens": settings.interpreter_max_tokens,
                "temperature": 0.1,
            },
        )
    except httpx.HTTPError as exc:
        log.warning("interpreter LiteLLM network error: %s", exc)
        return []

    if r.status_code >= 400:
        log.warning("interpreter LiteLLM %s: %.200s", r.status_code, r.text)
        return []

    try:
        choices = r.json().get("choices") or [{}]
        content = ((choices[0] or {}).get("message", {}).get("content", "") or "").strip()
    except Exception as exc:  # noqa: BLE001
        log.warning("interpreter: failed to parse LiteLLM response: %s", exc)
        return []

    if content.startswith("```"):
        content = content.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        log.warning("interpreter: LLM returned non-JSON: %s — %.100s", exc, content)
        return []

    return parsed if isinstance(parsed, list) else []


def _normalise(row: dict[str, Any] | Any) -> dict[str, Any]:
    if isinstance(row, dict):
        return row
    return {}


# ---------------------------------------------------------------------------
# Projector
# ---------------------------------------------------------------------------


class Interpreter(BaseProjector):
    """Projector: investigation_requested → LLM reasoning → INTERPRETED facts."""

    name = "interpreter"
    interested_event_types = ("investigation_requested",)

    def __init__(
        self, settings: ProjectorSettings, interp_settings: InterpreterSettings
    ) -> None:
        super().__init__(settings)
        self._cfg = interp_settings

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
            log.warning("interpreter: event %s has no fact_id; skipping", event_id)
            return

        async with await psycopg.AsyncConnection.connect(
            self.settings.postgres_dsn, row_factory=dict_row
        ) as conn:
            await self._interpret(conn, str(fact_id))
            await conn.commit()

    async def _interpret(
        self,
        conn: psycopg.AsyncConnection[dict[str, Any]],
        fact_id: str,
    ) -> None:
        # Budget gate
        if not await _check_daily_budget(conn, self._cfg.interpreter_daily_llm_budget_usd):
            log.info("interpreter: daily LLM budget exhausted; skipping fact %s", fact_id)
            return

        source_fact = await _fetch_fact(conn, fact_id)
        if not source_fact:
            log.warning("interpreter: fact %s not found", fact_id)
            return

        # Depth cap
        source_depth = int(_normalise(source_fact).get("derivation_depth") or 0)
        new_depth = source_depth + 1
        if new_depth > self._cfg.interpreter_max_derivation_depth:
            log.debug(
                "interpreter: fact %s at depth %d >= max %d; skipping",
                fact_id, source_depth, self._cfg.interpreter_max_derivation_depth,
            )
            return

        predicate = str(source_fact.get("predicate", "") or "")
        subject_label = str(source_fact.get("subject_label", "") or "")
        subject_id = str(source_fact.get("subject_id_value", "") or "")

        peer_facts = await _fetch_peer_facts(conn, predicate, subject_label, fact_id)
        subject_facts = await _fetch_subject_facts(conn, subject_id, fact_id)
        prompt = await _load_prompt(conn)

        user_content = json.dumps(
            {
                "source_fact": {
                    "id": source_fact.get("id"),
                    "subject_label": subject_label,
                    "subject_id_value": subject_id,
                    "predicate": predicate,
                    "object_value": source_fact.get("object_value"),
                    "unit": source_fact.get("unit"),
                    "confidence": source_fact.get("confidence"),
                    "derivation_class": source_fact.get("derivation_class"),
                },
                "peer_facts": [
                    {"predicate": predicate, "object_value": _normalise(r).get("object_value"),
                     "unit": _normalise(r).get("unit"), "confidence": _normalise(r).get("confidence")}
                    for r in peer_facts
                ],
                "subject_facts": [
                    {"predicate": _normalise(r).get("predicate"),
                     "object_value": _normalise(r).get("object_value"),
                     "unit": _normalise(r).get("unit"),
                     "confidence": _normalise(r).get("confidence")}
                    for r in subject_facts
                ],
            },
            default=str,
        )[:40000]

        async with httpx.AsyncClient(timeout=60.0) as client:
            raw_interpretations = await _call_llm(client, self._cfg, prompt, user_content)

        # Estimate cost ≈ $0.0005 per LiteLLM call with haiku (rough heuristic)
        await _record_llm_spend(conn, 0.0005)

        inserted = 0
        for raw in raw_interpretations:
            if not isinstance(raw, dict):
                continue
            raw_pred = raw.get("predicate")
            if not isinstance(raw_pred, str) or not raw_pred:
                continue
            raw_conf = raw.get("confidence")
            try:
                conf = min(float(raw_conf), _MAX_INTERPRETED_CONFIDENCE)
            except (TypeError, ValueError):
                conf = 0.40
            if conf <= 0.0:
                continue

            new_id = await _insert_interpreted_fact(
                conn=conn,
                source_fact=source_fact,
                predicate=str(raw_pred),
                object_value=raw.get("object_value"),
                unit=raw.get("unit"),
                confidence=conf,
                derivation_depth=new_depth,
            )
            if new_id:
                await _emit_interpretation_event(conn, new_id, fact_id, str(raw_pred))
                inserted += 1

        log.info(
            "interpreter: fact=%s derived %d INTERPRETED facts (depth %d→%d)",
            fact_id, inserted, source_depth, new_depth,
        )


def main() -> None:  # pragma: no cover
    base_settings = ProjectorSettings()
    interp_settings = InterpreterSettings()
    configure_logging(base_settings.projector_log_level)
    asyncio.run(Interpreter(base_settings, interp_settings).run())


if __name__ == "__main__":  # pragma: no cover
    main()
