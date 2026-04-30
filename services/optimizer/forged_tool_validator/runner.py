"""Nightly validation runner — Phase D.5.

Connects to Postgres, iterates active forged tools, runs validation,
writes results to forged_tool_validation_runs, auto-disables failing tools.

Scheduled via APScheduler (runs nightly at 02:00 UTC).
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row
from apscheduler.schedulers.blocking import BlockingScheduler

from .sandbox_client import LocalSubprocessSandbox, SandboxClient
from .validator import ForgedTool, ForgedToolValidator, TestCase, ValidationResult

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------


def _get_dsn() -> str:
    return (
        f"host={os.environ.get('POSTGRES_HOST', 'localhost')} "
        f"port={os.environ.get('POSTGRES_PORT', '5432')} "
        f"dbname={os.environ.get('POSTGRES_DB', 'chemclaw')} "
        f"user={os.environ.get('POSTGRES_USER', 'chemclaw')} "
        f"password={os.environ.get('POSTGRES_PASSWORD', '')}"
    )


def _fetch_active_forged_tools(conn: Any) -> list[ForgedTool]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT id::text, name, scripts_path
            FROM skill_library
            WHERE kind = 'forged_tool' AND active = true
            """
        )
        rows = cur.fetchall()

    tools: list[ForgedTool] = []
    for row in rows:
        tool_id = row["id"]

        # Load test cases.
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT id::text, input_json, expected_output_json,
                       tolerance_json, kind
                FROM forged_tool_tests
                WHERE forged_tool_id = %s::uuid
                ORDER BY created_at ASC
                """,
                (tool_id,),
            )
            tc_rows = cur.fetchall()

        test_cases: list[TestCase] = []
        for tc in tc_rows:
            test_cases.append(
                TestCase(
                    id=tc["id"],
                    input_json=tc["input_json"] if isinstance(tc["input_json"], dict) else json.loads(tc["input_json"]),
                    expected_output_json=tc["expected_output_json"] if isinstance(tc["expected_output_json"], dict) else json.loads(tc["expected_output_json"]),
                    tolerance_json=tc["tolerance_json"] if isinstance(tc.get("tolerance_json"), dict) else None,
                    kind=tc["kind"],
                )
            )

        # Load prompt_md to extract schemas (stored as markdown; parse JSON blocks).
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT prompt_md FROM skill_library WHERE id = %s::uuid",
                (tool_id,),
            )
            prompt_row = cur.fetchone()

        input_schema, output_schema = _parse_schemas_from_prompt_md(
            prompt_row["prompt_md"] if prompt_row else ""
        )

        tools.append(
            ForgedTool(
                id=tool_id,
                name=row["name"],
                scripts_path=row["scripts_path"],
                input_schema=input_schema,
                output_schema=output_schema,
                test_cases=test_cases,
            )
        )

    return tools


def _parse_schemas_from_prompt_md(
    prompt_md: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Extract input and output JSON schemas from the stored prompt_md markdown."""
    import re

    # Match ``` json blocks after Input schema / Output schema headers.
    input_schema: dict[str, Any] = {"type": "object", "properties": {}}
    output_schema: dict[str, Any] = {"type": "object", "properties": {}}

    blocks = re.findall(r"```json\s*([\s\S]*?)```", prompt_md)
    if len(blocks) >= 1:
        try:
            input_schema = json.loads(blocks[0])
        except json.JSONDecodeError:
            pass
    if len(blocks) >= 2:
        try:
            output_schema = json.loads(blocks[1])
        except json.JSONDecodeError:
            pass

    return input_schema, output_schema


def _write_validation_run(conn: Any, result: ValidationResult) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO forged_tool_validation_runs
              (id, forged_tool_id, run_at, total_tests, passed, failed, status, errors_json)
            VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s::jsonb)
            """,
            (
                str(uuid.uuid4()),
                result.tool_id,
                datetime.now(tz=timezone.utc),
                result.total_tests,
                result.passed,
                result.failed,
                result.status,
                json.dumps(result.errors),
            ),
        )

    if result.status == "failing":
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE skill_library SET active = false WHERE id = %s::uuid",
                (result.tool_id,),
            )
        logger.warning(
            "forge-validator: auto-disabled tool %s (status=failing, pass-rate=%d/%d)",
            result.tool_id,
            result.passed,
            result.total_tests,
        )
    elif result.status == "degraded":
        logger.warning(
            "forge-validator: tool %s is DEGRADED (%d/%d passed); left active with warning",
            result.tool_id,
            result.passed,
            result.total_tests,
        )

    conn.commit()


# ---------------------------------------------------------------------------
# Main run
# ---------------------------------------------------------------------------


def run_validation(sandbox: SandboxClient | None = None) -> list[ValidationResult]:
    if sandbox is None:
        sandbox = LocalSubprocessSandbox()

    conn = psycopg.connect(_get_dsn())
    try:
        tools = _fetch_active_forged_tools(conn)
        logger.info("forge-validator: validating %d active forged tools", len(tools))

        validator = ForgedToolValidator(sandbox)
        results: list[ValidationResult] = []

        for tool in tools:
            try:
                result = validator.validate_tool(tool)
                _write_validation_run(conn, result)
                results.append(result)
                logger.info(
                    "forge-validator: tool=%s status=%s (%d/%d passed)",
                    tool.name,
                    result.status,
                    result.passed,
                    result.total_tests,
                )
            except Exception as exc:
                logger.error(
                    "forge-validator: unexpected error for tool %s: %s",
                    tool.id,
                    exc,
                    exc_info=True,
                )

        return results
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Scheduler entry point
# ---------------------------------------------------------------------------


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    logger.info("forge-validator: starting nightly scheduler (02:00 UTC)")

    scheduler = BlockingScheduler(timezone="UTC")
    scheduler.add_job(run_validation, "cron", hour=2, minute=0)

    # Also run immediately on startup so the first nightly result is not delayed.
    run_validation()

    scheduler.start()


if __name__ == "__main__":
    main()
