"""test_planner — discriminating experiment design from hypotheses (Phase 5).

Subscribes to `hypothesis_proposed` events. For each hypothesis:

  1. Budget-gate: check daily CPU hours (cpu_hours_spent) in investigation_budget_usage.
     LLM spend for this call is negligible; the budget guard is mainly for the
     downstream compute (QM, BO, HTE) the test will trigger.
  2. Fetch the hypothesis fact from `facts`.
  3. Load the `kg.test_planning` prompt from prompt_registry.
  4. Call LiteLLM. Response: JSON with
       {
         "campaign_name": "<string>",
         "campaign_kind": "single_experiment"|"bo_campaign"|"screening",
         "goal": {<synthesis_campaigns.goal>},
         "steps": [
           {"kind": "<step_kind>", "inputs": {...}, "notes": "<rationale>"}
         ]
       }
  5. Validate: campaign_kind ∈ allowed_kinds; step.kind ∈ allowed_step_kinds.
  6. INSERT a new synthesis_campaign (status='proposed', policy={auto_advance:true}).
  7. INSERT synthesis_campaign_steps for each step in the plan.
  8. Emit `test_planned` ingestion event.
  9. Record cpu budget usage (flat 0.5 CPU-hours per planned test as a coarse estimate).

Full autonomy: budget is the only gate. No human-approval policy is set on
the created campaign — the synthesis-campaign machinery can execute immediately.
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

log = logging.getLogger("projector.test_planner")

_ALLOWED_CAMPAIGN_KINDS = frozenset({
    "single_experiment", "library_synthesis", "screening", "bo_campaign",
})
_ALLOWED_STEP_KINDS = frozenset({
    "retrosynthesis", "literature_pull", "condition_design", "library_design",
    "hte_plate_design", "bo_round", "forward_prediction", "qm_screen",
    "mechanism_check", "feasibility_assessment", "submit_batch",
    "measurement_wait", "ingest_results", "readiness_gate", "summary",
})
_CPU_HOURS_PER_PLAN = 0.5  # coarse estimate per planned test campaign

_FALLBACK_PROMPT = """\
You are an expert pharmaceutical chemist designing discriminating experiments
to confirm or refute a scientific hypothesis.

Given a hypothesis (a HYPOTHESIZED fact from the knowledge graph), design a
minimal, executable experiment plan that will produce evidence to confirm or
refute it.

Return a single JSON object — and ONLY that object, no preamble:
{
  "campaign_name": "<concise experiment name>",
  "campaign_kind": "single_experiment" | "screening" | "bo_campaign",
  "goal": {
    "hypothesis_fact_id": "<the hypothesis fact id>",
    "discriminating_condition": "<what measurement would confirm vs refute>",
    "success_criterion": "<specific observable outcome>"
  },
  "steps": [
    {
      "kind": "<one of: retrosynthesis | condition_design | forward_prediction | qm_screen | mechanism_check | feasibility_assessment | bo_round | hte_plate_design | submit_batch | measurement_wait | ingest_results | summary>",
      "inputs": {<step-specific input parameters as JSON object>},
      "notes": "<one-sentence rationale for this step>"
    }
  ]
}

Rules:
- Design the minimal number of steps needed. 1-4 steps is typical.
- Each step must use an exact kind from the allowed list above.
- Inputs must be specific (SMILES, temperature ranges, factor names, etc.)
  drawn from the hypothesis fact and its context. Do not invent identifiers.
- If the hypothesis cannot be tested with available tools, return
  {"campaign_name": null, "campaign_kind": null, "goal": {}, "steps": []}.
"""


class TestPlannerSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_db: str = "chemclaw"
    postgres_user: str = "chemclaw_service"
    postgres_password: str = ""

    litellm_base_url: str = "http://litellm:4000"
    litellm_api_key: str = "sk-chemclaw-dev-master-change-me"
    test_planner_model: str = "claude-haiku-4-5"
    test_planner_max_tokens: int = 2048
    test_planner_daily_cpu_budget_hours: float = 100.0
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


async def _check_cpu_budget(
    conn: psycopg.AsyncConnection[dict[str, Any]], budget_hours: float
) -> bool:
    today = datetime.now(timezone.utc).date().isoformat()
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT COALESCE(SUM(cpu_hours_spent), 0) AS spent "
            "FROM investigation_budget_usage WHERE scope = 'global' AND date_utc = %s",
            (today,),
        )
        row = await cur.fetchone()
    spent = float((row.get("spent") if isinstance(row, dict) else row[0]) or 0)
    return spent < budget_hours


async def _record_cpu_spend(
    conn: psycopg.AsyncConnection[dict[str, Any]], cpu_hours: float
) -> None:
    today = datetime.now(timezone.utc).date().isoformat()
    async with conn.cursor() as cur:
        await cur.execute(
            "INSERT INTO investigation_budget_usage (scope, scope_id, date_utc, cpu_hours_spent) "
            "VALUES ('global', '', %s, %s) "
            "ON CONFLICT (scope, scope_id, date_utc) "
            "DO UPDATE SET cpu_hours_spent = investigation_budget_usage.cpu_hours_spent + EXCLUDED.cpu_hours_spent",
            (today, cpu_hours),
        )


async def _fetch_hypothesis_fact(
    conn: psycopg.AsyncConnection[dict[str, Any]], fact_id: str
) -> dict[str, Any] | None:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT id::text AS id, subject_label, subject_id_value, predicate, "
            "       object_value, project_id::text AS project_id, confidence, "
            "       derivation_class "
            "FROM facts WHERE id = %s::uuid AND derivation_class = 'HYPOTHESIZED'"
            " AND valid_to IS NULL",
            (fact_id,),
        )
        return await cur.fetchone()


async def _load_prompt(conn: psycopg.AsyncConnection[dict[str, Any]]) -> str:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT template FROM prompt_registry "
            "WHERE prompt_name = %s AND active ORDER BY version DESC LIMIT 1",
            ("kg.test_planning",),
        )
        row = await cur.fetchone()
    if row is not None:
        tmpl = (row.get("template") if isinstance(row, dict) else row[0]) or ""
        if isinstance(tmpl, str) and tmpl.strip():
            return tmpl
    return _FALLBACK_PROMPT


async def _create_campaign(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    name: str,
    kind: str,
    goal: dict[str, Any],
    project_id: str,
    hypothesis_fact_id: str,
) -> str:
    """Insert a synthesis_campaign row and return its id."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO synthesis_campaigns
              (nce_project_id, name, kind, goal, policy, status, created_by_user_entra_id)
            VALUES (%s::uuid, %s, %s, %s::jsonb, %s::jsonb, 'proposed', 'test_planner')
            RETURNING id::text
            """,
            (
                project_id,
                str(name)[:200],
                str(kind),
                json.dumps(goal),
                json.dumps({"auto_advance": True, "require_user_approval": False}),
            ),
        )
        row = await cur.fetchone()
    return str(row.get("id") if isinstance(row, dict) else row[0])


async def _create_step(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    campaign_id: str,
    step_index: int,
    kind: str,
    inputs: dict[str, Any],
    notes: str,
) -> str:
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO synthesis_campaign_steps
              (campaign_id, step_index, kind, inputs, notes)
            VALUES (%s::uuid, %s, %s, %s::jsonb, %s)
            RETURNING id::text
            """,
            (campaign_id, step_index, kind, json.dumps(inputs), str(notes)[:1000]),
        )
        row = await cur.fetchone()
    return str(row.get("id") if isinstance(row, dict) else row[0])


async def _emit_test_planned(
    conn: psycopg.AsyncConnection[dict[str, Any]],
    hypothesis_fact_id: str,
    campaign_id: str,
    step_ids: list[str],
) -> None:
    async with conn.cursor() as cur:
        await cur.execute(
            "INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload) "
            "VALUES ('test_planned', 'synthesis_campaigns', %s, "
            "        jsonb_build_object('campaign_id', %s::text, "
            "                           'hypothesis_fact_id', %s::text, "
            "                           'step_ids', %s::jsonb, "
            "                           'extractor', 'test_planner'))",
            (campaign_id, campaign_id, hypothesis_fact_id, json.dumps(step_ids)),
        )


# ---------------------------------------------------------------------------
# LLM
# ---------------------------------------------------------------------------


async def _call_llm(
    client: httpx.AsyncClient,
    settings: TestPlannerSettings,
    system_prompt: str,
    user_content: str,
) -> dict[str, Any] | None:
    try:
        r = await client.post(
            f"{settings.litellm_base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {settings.litellm_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": settings.test_planner_model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
                "max_tokens": settings.test_planner_max_tokens,
                "temperature": 0.1,
            },
        )
    except httpx.HTTPError as exc:
        log.warning("test_planner LiteLLM network error: %s", exc)
        return None

    if r.status_code >= 400:
        log.warning("test_planner LiteLLM %s: %.200s", r.status_code, r.text)
        return None

    try:
        choices = r.json().get("choices") or [{}]
        content = ((choices[0] or {}).get("message", {}).get("content", "") or "").strip()
    except Exception as exc:  # noqa: BLE001
        log.warning("test_planner: failed to parse LiteLLM response: %s", exc)
        return None

    if content.startswith("```"):
        content = content.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        log.warning("test_planner: LLM returned non-JSON: %s — %.100s", exc, content)
        return None

    return parsed if isinstance(parsed, dict) else None


def _validate_plan(plan: dict[str, Any]) -> bool:
    """Return True if the plan is structurally valid and actionable."""
    if not plan.get("campaign_name") or not plan.get("campaign_kind"):
        return False
    if plan.get("campaign_kind") not in _ALLOWED_CAMPAIGN_KINDS:
        return False
    steps = plan.get("steps")
    if not isinstance(steps, list) or not steps:
        return False
    for step in steps:
        if not isinstance(step, dict):
            return False
        if step.get("kind") not in _ALLOWED_STEP_KINDS:
            return False
    return True


# ---------------------------------------------------------------------------
# Projector
# ---------------------------------------------------------------------------


class TestPlanner(BaseProjector):
    """Projector: hypothesis_proposed → experiment plan → synthesis_campaign_steps."""

    name = "test_planner"
    interested_event_types = ("hypothesis_proposed",)

    def __init__(
        self, settings: ProjectorSettings, planner_settings: TestPlannerSettings
    ) -> None:
        super().__init__(settings)
        self._cfg = planner_settings

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
            log.warning("test_planner: event %s has no fact_id; skipping", event_id)
            return

        async with await psycopg.AsyncConnection.connect(
            self.settings.postgres_dsn, row_factory=dict_row
        ) as conn:
            await self._plan_test(conn, str(fact_id))
            await conn.commit()

    async def _plan_test(
        self,
        conn: psycopg.AsyncConnection[dict[str, Any]],
        fact_id: str,
    ) -> None:
        if not await _check_cpu_budget(conn, self._cfg.test_planner_daily_cpu_budget_hours):
            log.info("test_planner: daily CPU budget exhausted; skipping hypothesis %s", fact_id)
            return

        hypothesis = await _fetch_hypothesis_fact(conn, fact_id)
        if not hypothesis:
            log.debug("test_planner: fact %s is not a HYPOTHESIZED fact; skipping", fact_id)
            return

        project_id: str | None = hypothesis.get("project_id")
        if not project_id:
            log.info("test_planner: hypothesis %s has no project_id; cannot create campaign", fact_id)
            return

        prompt = await _load_prompt(conn)

        def _r(row: Any) -> dict[str, Any]:
            return row if isinstance(row, dict) else {}

        user_content = json.dumps(
            {
                "hypothesis": {
                    "id": hypothesis.get("id"),
                    "subject_label": hypothesis.get("subject_label"),
                    "subject_id_value": hypothesis.get("subject_id_value"),
                    "predicate": hypothesis.get("predicate"),
                    "object_value": _r(hypothesis).get("object_value"),
                    "confidence": _r(hypothesis).get("confidence"),
                },
                "instructions": (
                    "Design a minimal, executable experiment to confirm or refute this hypothesis. "
                    "All steps must use only the tools and step kinds available in ChemClaw."
                ),
            },
            default=str,
        )[:20000]

        async with httpx.AsyncClient(timeout=60.0) as client:
            plan = await _call_llm(client, self._cfg, prompt, user_content)

        if plan is None or not _validate_plan(plan):
            log.info(
                "test_planner: LLM returned no actionable plan for hypothesis %s", fact_id
            )
            return

        campaign_kind = str(plan.get("campaign_kind", "single_experiment"))
        campaign_name = str(plan.get("campaign_name", f"Hypothesis test: {fact_id[:8]}"))
        goal = plan.get("goal") or {}
        if isinstance(goal, dict):
            goal["hypothesis_fact_id"] = fact_id
        else:
            goal = {"hypothesis_fact_id": fact_id}

        campaign_id = await _create_campaign(
            conn, campaign_name, campaign_kind, goal, project_id, fact_id
        )

        steps = plan.get("steps") or []
        step_ids: list[str] = []
        for idx, step in enumerate(steps):
            if not isinstance(step, dict):
                continue
            kind = str(step.get("kind", "summary"))
            if kind not in _ALLOWED_STEP_KINDS:
                continue
            inputs = step.get("inputs") or {}
            notes = str(step.get("notes") or "")
            step_id = await _create_step(conn, campaign_id, idx, kind, inputs, notes)
            step_ids.append(step_id)

        await _emit_test_planned(conn, fact_id, campaign_id, step_ids)
        await _record_cpu_spend(conn, _CPU_HOURS_PER_PLAN)

        log.info(
            "test_planner: hypothesis=%s → campaign=%s (%s, %d steps)",
            fact_id, campaign_id, campaign_kind, len(step_ids),
        )


def main() -> None:  # pragma: no cover
    base_settings = ProjectorSettings()
    planner_settings = TestPlannerSettings()
    configure_logging(base_settings.projector_log_level)
    asyncio.run(TestPlanner(base_settings, planner_settings).run())


if __name__ == "__main__":  # pragma: no cover
    main()
