"""GEPA runner — nightly cron at 02:00 UTC.

Reads prompt_registry, fetches Langfuse traces + feedback_events,
runs DSPy GEPA, inserts candidate rows (active=false, shadow_until=+7d).

Exposes a tiny FastAPI /healthz endpoint reporting last run status.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import psycopg
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI

from .examples import traces_to_examples
from .gepa import run_gepa, GepaResult
from .langfuse_client import LangfuseTraceClient

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# State shared between the scheduler job and the health endpoint.
# ---------------------------------------------------------------------------

_last_run_at: datetime | None = None
_last_run_status: str = "never"
_last_run_details: dict[str, Any] = {}

# ---------------------------------------------------------------------------
# DSPy LM configuration
# ---------------------------------------------------------------------------

def _configure_dspy_lm() -> None:
    """Configure DSPy's global LM to point at the LiteLLM gateway.

    DSPy needs a configured LM before any optimiser can compile a module.
    The agent-claw service routes every LLM call through LiteLLM (the
    project's single egress chokepoint — see CLAUDE.md / ADR 006); the
    optimiser uses the same gateway so the redactor callback applies
    uniformly to training-time calls.

    Raises:
        RuntimeError: if LITELLM_BASE_URL / LITELLM_API_KEY are unset.
        Failing fast here lets ``run_gepa_nightly`` mark the run as 'error'
        so /healthz is honest about what didn't run.
    """
    import dspy

    base = os.environ.get("LITELLM_BASE_URL")
    api_key = os.environ.get("LITELLM_API_KEY")
    if not base or not api_key:
        raise RuntimeError(
            "LITELLM_BASE_URL and LITELLM_API_KEY must be set; the GEPA "
            "runner uses the LiteLLM gateway as its single egress point. "
            "Without an LM configured, every prompt errors silently."
        )
    model_alias = os.environ.get("GEPA_MODEL", "executor")
    # DSPy's LiteLLM provider expects "openai/<model_or_alias>" so it routes
    # through the OpenAI-compatible adapter; LiteLLM itself maps the alias
    # to the upstream provider per services/litellm/config.yaml.
    lm = dspy.LM(
        model=f"openai/{model_alias}",
        api_base=base,
        api_key=api_key,
    )
    dspy.configure(lm=lm)
    logger.info("DSPy LM configured via LiteLLM (model=%s)", model_alias)


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def _get_dsn() -> str:
    """Compose the DSN for the nightly GEPA optimiser.

    Default user is ``chemclaw_service`` (LOGIN BYPASSRLS) — required since
    ``db/init/12_security_hardening.sql`` and ``16_db_audit_fixes.sql``
    applied FORCE ROW LEVEL SECURITY to ``prompt_registry`` and
    ``feedback_events``. Connecting as the owner role (``chemclaw``) without
    setting ``app.current_user_entra_id`` would silently return zero rows
    from every SELECT and silently DROP every INSERT, leaving the
    self-improvement loop dead while ``/healthz`` reported green. The
    docker-compose block already exports ``POSTGRES_USER=chemclaw_service``
    explicitly; this default ensures direct invocation (``python -m
    services.optimizer.gepa_runner.runner`` in CI / manual smoke) doesn't
    fall into the same hole.
    """
    return (
        f"host={os.environ.get('POSTGRES_HOST', 'localhost')} "
        f"port={os.environ.get('POSTGRES_PORT', '5432')} "
        f"dbname={os.environ.get('POSTGRES_DB', 'chemclaw')} "
        f"user={os.environ.get('POSTGRES_USER', 'chemclaw_service')} "
        f"password={os.environ.get('POSTGRES_PASSWORD', '')}"
    )


def _fetch_active_prompts(conn: psycopg.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, prompt_name, version, template
        FROM prompt_registry
        WHERE active = true
        ORDER BY prompt_name, version
        """
    ).fetchall()
    return [{"id": str(r[0]), "name": r[1], "version": r[2], "template": r[3]} for r in rows]


def _fetch_feedback_events(
    conn: psycopg.Connection,
    prompt_name: str,
    hours: int = 24,
) -> list[dict[str, Any]]:
    since = datetime.now(tz=timezone.utc) - timedelta(hours=hours)
    rows = conn.execute(
        """
        SELECT signal, trace_id, created_at
        FROM feedback_events
        WHERE prompt_name = %s
          AND created_at >= %s
        ORDER BY created_at DESC
        """,
        (prompt_name, since),
    ).fetchall()
    return [{"signal": r[0], "trace_id": str(r[1] or ""), "created_at": r[2]} for r in rows]


def _insert_candidate(
    conn: psycopg.Connection,
    prompt_name: str,
    current_version: int,
    new_template: str,
    gepa_metadata: dict[str, Any],
) -> None:
    new_version = current_version + 1
    shadow_until = datetime.now(tz=timezone.utc) + timedelta(days=7)
    conn.execute(
        """
        INSERT INTO prompt_registry
          (id, prompt_name, version, template, created_by,
           active, shadow_until, gepa_metadata)
        VALUES (%s, %s, %s, %s, %s, false, %s, %s)
        ON CONFLICT (prompt_name, version) DO NOTHING
        """,
        (
            str(uuid.uuid4()),
            prompt_name,
            new_version,
            new_template,
            "gepa-runner",
            shadow_until,
            json.dumps(gepa_metadata),
        ),
    )
    conn.commit()
    logger.info(
        "Inserted candidate prompt %s v%d (shadow until %s)",
        prompt_name,
        new_version,
        shadow_until.isoformat(),
    )


# ---------------------------------------------------------------------------
# Golden-set fixture loader
# ---------------------------------------------------------------------------

def _load_golden_examples(fixture_path: str | None = None) -> list[Any]:
    import dspy

    path = Path(fixture_path or os.environ.get(
        "GEPA_GOLDEN_FIXTURE",
        "tests/golden/chem_qa_v1.fixture.jsonl",
    ))
    if not path.exists():
        logger.warning("Golden fixture not found at %s; golden score will be 0", path)
        return []

    examples: list[dspy.Example] = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
            ex = dspy.Example(
                question=d.get("question", ""),
                answer=d.get("answer", ""),
                feedback="",
                tool_outputs=[],
                query_class=d.get("expected_classes", ["cross_project"])[0],
            ).with_inputs("question")
            examples.append(ex)
        except Exception as exc:
            logger.warning("Skipping malformed golden example: %s", exc)

    return examples


# ---------------------------------------------------------------------------
# Main GEPA job
# ---------------------------------------------------------------------------

async def run_gepa_nightly(
    *,
    langfuse_client: LangfuseTraceClient | None = None,
    fixture_path: str | None = None,
) -> None:
    global _last_run_at, _last_run_status, _last_run_details

    _last_run_at = datetime.now(tz=timezone.utc)
    _last_run_status = "running"
    details: dict[str, Any] = {}

    try:
        # Wire DSPy to LiteLLM before doing anything else. A misconfigured
        # gateway turns every per-prompt run into an exception with no
        # actionable signal in /healthz; failing fast here marks the
        # run as 'error' so the operator notices the missing env var
        # immediately instead of after a week of green-but-empty runs.
        _configure_dspy_lm()

        dsn = _get_dsn()
        lf_client = langfuse_client or LangfuseTraceClient()
        golden_examples = _load_golden_examples(fixture_path)

        with psycopg.connect(dsn) as conn:
            prompts = _fetch_active_prompts(conn)
            logger.info("GEPA run starting — %d active prompts", len(prompts))

            # Zero active prompts is almost always a misconfiguration: either
            # the DB is freshly initialised (and `db.seed` hasn't run), or —
            # more dangerously — we connected as a role that FORCE RLS gates
            # to zero rows (the chemclaw owner role hits this on prompt_registry
            # post-12_security_hardening.sql + 16_db_audit_fixes.sql). Surface
            # this as `degraded` so /healthz doesn't lie about a working loop.
            if not prompts:
                details["__warning__"] = "no active prompts found in prompt_registry"
                details["__hint__"] = (
                    "if the schema has data, this is almost certainly an RLS "
                    "issue: GEPA must connect as chemclaw_service, not the "
                    "owner role (post-12_security_hardening.sql)"
                )
                logger.warning(
                    "GEPA run found 0 active prompts — check POSTGRES_USER "
                    "(must be chemclaw_service post-RLS hardening)"
                )
                _last_run_status = "degraded"
                _last_run_details = details
                return

            for prompt in prompts:
                name = prompt["name"]
                version = prompt["version"]
                template = prompt["template"]

                try:
                    traces = lf_client.fetch_traces_for_prompt(name, hours=24)
                    feedback_rows = _fetch_feedback_events(conn, name, hours=24)
                    examples = traces_to_examples(traces, feedback_rows)

                    result: GepaResult = run_gepa(
                        prompt_name=name,
                        current_template=template,
                        examples=examples,
                        golden_examples=golden_examples,
                    )

                    if result.skipped:
                        logger.info(
                            "GEPA skipped %s: %s", name, result.skip_reason
                        )
                        details[name] = {"status": "skipped", "reason": result.skip_reason}
                        continue

                    _insert_candidate(
                        conn, name, version, result.new_template, result.gepa_metadata
                    )
                    details[name] = {
                        "status": "candidate_inserted",
                        "new_version": version + 1,
                        "golden_score": result.golden_score,
                        "feedback_rate": result.feedback_rate,
                    }

                except Exception as exc:
                    logger.exception("GEPA failed for prompt %s: %s", name, exc)
                    details[name] = {"status": "error", "error": str(exc)}

        # Surface aggregate status honestly: 'ok' only if no per-prompt
        # error fired. `degraded` covers partial failure without masking
        # it as success so /healthz doesn't lie when GEPA can't reach
        # an LM, the registry, or Langfuse.
        any_error = any(
            isinstance(d, dict) and d.get("status") == "error"
            for d in details.values()
        )
        _last_run_status = "degraded" if any_error else "ok"
    except Exception as exc:
        logger.exception("GEPA nightly run failed: %s", exc)
        _last_run_status = "error"

    _last_run_details = details
    logger.info("GEPA run complete — status=%s", _last_run_status)


# ---------------------------------------------------------------------------
# FastAPI health endpoint
# ---------------------------------------------------------------------------

scheduler = AsyncIOScheduler()


@asynccontextmanager
async def _lifespan(app: FastAPI):
    scheduler.add_job(
        run_gepa_nightly,
        "cron",
        hour=2,
        minute=0,
        id="gepa_nightly",
        replace_existing=True,
    )
    scheduler.start()
    logger.info("GEPA scheduler started (02:00 UTC nightly)")
    yield
    scheduler.shutdown()


app = FastAPI(lifespan=_lifespan)


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {
        "service": "gepa-runner",
        "status": "ok",
        "last_run_at": _last_run_at.isoformat() if _last_run_at else None,
        "last_run_status": _last_run_status,
        "details": _last_run_details,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("GEPA_PORT", "8010")))
