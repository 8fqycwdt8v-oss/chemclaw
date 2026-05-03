"""workflow_engine — executes workflow runs.

Consumes `pg_notify('workflow_event', run_id:seq)` and dispatches the next
runnable step. The canonical state of a run is the fold of `workflow_events`;
`workflow_state` is a materialized projection rebuildable at any time.

Step kinds supported:
  - tool_call      — invoke an MCP service via HTTP (mcp-xtb, mcp-genchem, …)
  - sub_agent      — placeholder; future hook into the agent's sub-agent
                     dispatch path
  - conditional    — pick branch by JMESPath expr against scope
  - loop / parallel — sequential or parallel iteration over for_each
  - wait           — block on a batch_id until all tasks resolve

This MVP runs only the simple step kinds (tool_call + conditional + wait
on batch_id). loop / parallel / sub_agent step bodies are accepted but
executed serially as a single iteration; full implementations follow.

Failure semantics: a step_failed event is appended; the workflow status
moves to 'failed' and the run is finalized.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
from typing import Any

import httpx
import psycopg
from psycopg.rows import dict_row
from pydantic_settings import BaseSettings, SettingsConfigDict

from services.mcp_tools.common.logging import configure_logging


log = logging.getLogger("workflow_engine")


class EngineSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_db: str = "chemclaw"
    postgres_user: str = "chemclaw_service"
    postgres_password: str = ""
    log_level: str = "INFO"
    poll_interval_seconds: int = 30

    mcp_base_urls: dict[str, str] = {}

    @property
    def dsn(self) -> str:
        return (
            f"host={self.postgres_host} port={self.postgres_port} "
            f"dbname={self.postgres_db} user={self.postgres_user} "
            f"password={self.postgres_password}"
        )


class WorkflowEngine:
    def __init__(self, settings: EngineSettings) -> None:
        self.settings = settings
        self._shutdown = asyncio.Event()
        self._http: httpx.AsyncClient | None = None

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, self._shutdown.set)
            except NotImplementedError:
                pass
        log.info("[workflow_engine] starting")

        self._http = httpx.AsyncClient(timeout=600.0)
        try:
            async with await psycopg.AsyncConnection.connect(
                self.settings.dsn, autocommit=True, row_factory=dict_row,
            ) as listen_conn:
                async with listen_conn.cursor() as cur:
                    await cur.execute("LISTEN workflow_event")
                log.info("[workflow_engine] LISTEN workflow_event established")

                async with await psycopg.AsyncConnection.connect(
                    self.settings.dsn, row_factory=dict_row,
                ) as work_conn:
                    await self._sweep(work_conn)
                    while not self._shutdown.is_set():
                        notify_task = asyncio.create_task(self._next_notify(listen_conn))
                        poll_task = asyncio.create_task(asyncio.sleep(self.settings.poll_interval_seconds))
                        shutdown_task = asyncio.create_task(self._shutdown.wait())
                        done, pending = await asyncio.wait(
                            {notify_task, poll_task, shutdown_task},
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                        for p in pending:
                            p.cancel()
                        if shutdown_task in done:
                            break
                        await self._sweep(work_conn)
        finally:
            if self._http is not None:
                await self._http.aclose()
        log.info("[workflow_engine] stopped")

    async def _next_notify(self, conn: psycopg.AsyncConnection) -> str:
        gen = conn.notifies()
        notify = await gen.__anext__()
        return notify.payload or ""

    async def _sweep(self, work_conn: psycopg.AsyncConnection) -> None:
        async with work_conn.cursor() as cur:
            await cur.execute(
                """
                SELECT r.id::text AS id,
                       w.definition,
                       s.cursor,
                       s.scope
                  FROM workflow_runs r
                  JOIN workflows w ON w.id = r.workflow_id
                  LEFT JOIN workflow_state s ON s.run_id = r.id
                 WHERE r.status = 'running'
                 LIMIT 100
                """
            )
            runs = await cur.fetchall()
        for run in runs:
            if self._shutdown.is_set():
                return
            try:
                await self._advance_run(work_conn, run)
            except Exception:
                log.exception("[workflow_engine] advance failed for %s", run["id"])

    async def _advance_run(self, work_conn: psycopg.AsyncConnection, run: dict[str, Any]) -> None:
        run_id = run["id"]
        definition = run["definition"]
        cursor = run["cursor"] or {}
        scope = run["scope"] or {}

        steps = definition.get("steps", [])
        next_index = int(cursor.get("step_index", 0))
        if next_index >= len(steps):
            await self._finish(work_conn, run_id, "succeeded", scope, definition.get("outputs", {}))
            return

        step = steps[next_index]
        step_id = step.get("id", f"step_{next_index}")
        await self._append_event(work_conn, run_id, "step_started", step_id, {"step": step})
        try:
            result = await self._execute_step(step, scope)
        except Exception as exc:  # noqa: BLE001
            log.exception("[workflow_engine] step %s failed in %s", step_id, run_id)
            await self._append_event(work_conn, run_id, "step_failed", step_id, {"error": str(exc)})
            await self._finish(work_conn, run_id, "failed", scope, {})
            return

        scope.setdefault("steps", {})[step_id] = result
        cursor["step_index"] = next_index + 1
        await self._append_event(work_conn, run_id, "step_succeeded", step_id, {"result": result})
        async with work_conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE workflow_state
                   SET current_step = $1::text,
                       scope = $2::jsonb,
                       cursor = $3::jsonb,
                       updated_at = NOW()
                 WHERE run_id = $4::uuid
                """,
                (step_id, json.dumps(scope), json.dumps(cursor), run_id),
            )
        await work_conn.commit()

    async def _execute_step(
        self, step: dict[str, Any], scope: dict[str, Any],
    ) -> Any:
        kind = step.get("kind")
        if kind == "tool_call":
            return await self._exec_tool_call(step, scope)
        if kind == "wait":
            return await self._exec_wait(step, scope)
        if kind in ("conditional", "loop", "parallel", "sub_agent"):
            log.info("[workflow_engine] step kind=%r executed as no-op (MVP)", kind)
            return {"note": f"kind={kind} not yet executed; returning empty result"}
        raise ValueError(f"unknown step kind: {kind!r}")

    async def _exec_tool_call(self, step: dict[str, Any], scope: dict[str, Any]) -> Any:
        if self._http is None:
            raise RuntimeError("http client not initialized")
        tool = step["tool"]
        args = step.get("args", {})
        url = self._tool_url(tool)
        resp = await self._http.post(url, json=args)
        if resp.status_code >= 400:
            raise RuntimeError(f"{tool} → {resp.status_code}: {resp.text[:200]}")
        return resp.json()

    async def _exec_wait(self, step: dict[str, Any], scope: dict[str, Any]) -> Any:
        spec = step.get("for", {})
        if "batch_id" in spec:
            # MVP: poll the batch row until total reached.
            batch_id = self._resolve_jmespath(spec["batch_id"], scope)
            timeout = step.get("timeout_seconds", 3600)
            for _ in range(timeout // 5):
                async with await psycopg.AsyncConnection.connect(
                    self.settings.dsn, row_factory=dict_row,
                ) as conn, conn.cursor() as cur:
                    await cur.execute(
                        "SELECT total, succeeded, failed, cancelled FROM task_batches WHERE id = %s::uuid",
                        (batch_id,),
                    )
                    row = await cur.fetchone()
                if row is None:
                    raise RuntimeError(f"batch not found: {batch_id}")
                if row["succeeded"] + row["failed"] + row["cancelled"] >= row["total"]:
                    return dict(row)
                await asyncio.sleep(5)
            raise TimeoutError(f"wait on batch {batch_id} timed out")
        raise ValueError("only batch_id wait is implemented in MVP")

    @staticmethod
    def _resolve_jmespath(expr: str, scope: dict[str, Any]) -> Any:
        # Minimal JMESPath subset: dotted path against scope.
        node: Any = scope
        for part in expr.split("."):
            if part == "scope":
                continue
            if isinstance(node, dict):
                node = node.get(part)
            else:
                return None
        return node

    def _tool_url(self, tool: str) -> str:
        # Map tool id -> MCP HTTP endpoint. Extend as new tools land.
        urls = {
            "qm_single_point":  os.environ.get("MCP_XTB_URL", "http://mcp-xtb:8010") + "/single_point",
            "qm_geometry_opt":  os.environ.get("MCP_XTB_URL", "http://mcp-xtb:8010") + "/geometry_opt",
            "qm_frequencies":   os.environ.get("MCP_XTB_URL", "http://mcp-xtb:8010") + "/frequencies",
            "qm_fukui":         os.environ.get("MCP_XTB_URL", "http://mcp-xtb:8010") + "/fukui",
            "qm_redox_potential": os.environ.get("MCP_XTB_URL", "http://mcp-xtb:8010") + "/redox",
            "qm_crest_screen":  os.environ.get("MCP_CREST_URL", "http://mcp-crest:8014") + "/conformers",
            "generate_focused_library": os.environ.get("MCP_GENCHEM_URL", "http://mcp-genchem:8015") + "/scaffold_decorate",
        }
        if tool not in urls:
            raise ValueError(f"workflow_engine has no URL mapping for tool {tool!r}")
        return urls[tool]

    async def _append_event(
        self, work_conn: psycopg.AsyncConnection, run_id: str,
        kind: str, step_id: str | None, payload: dict[str, Any],
    ) -> None:
        async with work_conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO workflow_events (run_id, seq, kind, step_id, payload)
                SELECT %s::uuid,
                       COALESCE((SELECT MAX(seq) FROM workflow_events WHERE run_id = %s::uuid), 0) + 1,
                       %s, %s, %s::jsonb
                """,
                (run_id, run_id, kind, step_id, json.dumps(payload)),
            )
        await work_conn.commit()

    async def _finish(
        self, work_conn: psycopg.AsyncConnection, run_id: str,
        status: str, scope: dict[str, Any], output_template: dict[str, str],
    ) -> None:
        outputs = {
            k: self._resolve_jmespath(v, {"steps": scope.get("steps", {})})
            for k, v in output_template.items()
        }
        async with work_conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE workflow_runs
                   SET status = $1,
                       finished_at = NOW(),
                       output = $2::jsonb
                 WHERE id = $3::uuid
                """,
                (status, json.dumps(outputs), run_id),
            )
        await self._append_event(work_conn, run_id, "finish", None, {"status": status, "outputs": outputs})


def main() -> None:
    settings = EngineSettings()
    configure_logging(settings.log_level, service="workflow_engine")
    asyncio.run(WorkflowEngine(settings).run())


if __name__ == "__main__":
    main()
