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
import jmespath
import psycopg
from psycopg.rows import dict_row
from pydantic_settings import BaseSettings, SettingsConfigDict

from services.common.config_registry import ConfigRegistry
from services.mcp_tools.common.logging import configure_logging
from services.mcp_tools.common.mcp_token_cache import McpTokenCache


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
        self._token_cache = McpTokenCache(default_subject="workflow-engine")
        # Dedicated connection for `wait`-step polling. Kept distinct from
        # `work_conn` so a long-running `_exec_wait` (timeouts up to 1h) does
        # not hold an open transaction against the run-state cursor that
        # `_advance_run` updates. Lazily opened on first `wait` step.
        self._poll_conn: psycopg.AsyncConnection | None = None
        # config_settings reader for tunable knobs (HTTP timeout, wait poll
        # interval, default wait-step timeout). Falls back to the embedded
        # default if the table is unreachable, so the engine starts on a
        # fresh DB before the migration runs.
        self._config = ConfigRegistry(dsn=self.settings.dsn)

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, self._shutdown.set)
            except NotImplementedError:
                pass
        log.info("[workflow_engine] starting")

        # http_timeout_seconds is config-tunable; the 600s embedded default
        # matches the pre-config baseline so existing deployments behave
        # identically when the row is absent.
        http_timeout = self._config.get_float(
            "workflow_engine.http_timeout_seconds", 600.0,
        )
        self._http = httpx.AsyncClient(timeout=http_timeout)
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
            if self._poll_conn is not None:
                await self._poll_conn.close()
                self._poll_conn = None
        log.info("[workflow_engine] stopped")

    async def _next_notify(self, conn: psycopg.AsyncConnection) -> str:
        gen = conn.notifies()
        notify = await gen.__anext__()
        return notify.payload or ""

    async def _sweep(self, work_conn: psycopg.AsyncConnection) -> None:
        # FOR UPDATE SKIP LOCKED on workflow_runs: when two engine replicas
        # both poll the queue, each claims a disjoint subset of running rows.
        # Without it, both replicas race on the same workflow_state UPDATE
        # and the second-write wins, potentially clobbering the first
        # replica's cursor advance. The lock is held for the duration of
        # this sweep iteration; _advance_run completes its commit before
        # the cursor's transaction releases.
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
                   FOR UPDATE OF r SKIP LOCKED
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

        # Take a session-scoped advisory lock keyed on the run_id BEFORE the
        # first internal commit. The FOR UPDATE OF r SKIP LOCKED row lock
        # acquired in _sweep is released as soon as _append_event commits
        # (the very first thing this method does), at which point a peer
        # replica's next sweep can pick up the same run and race on
        # _execute_step. The advisory lock survives intermediate commits
        # and is released only in the finally below, so two replicas
        # serialise on the same run for the entire advance cycle.
        #
        # pg_try_advisory_lock returns FALSE if a peer already holds it →
        # we skip the run silently; the peer will finish and the next
        # NOTIFY / poll cycle re-evaluates.
        async with work_conn.cursor() as cur:
            await cur.execute(
                "SELECT pg_try_advisory_lock(hashtext(%s), hashtext(%s::text)) AS got",
                ("workflow_run_advance", run_id),
            )
            row = await cur.fetchone()
            got_lock = bool(row and row.get("got"))
        # The SELECT above leaves a transaction open on work_conn; commit so
        # later _append_event commits start clean. Advisory session locks
        # are NOT released by COMMIT — only pg_advisory_unlock or session
        # close releases them.
        await work_conn.commit()

        if not got_lock:
            log.debug("[workflow_engine] run %s held by peer; skipping", run_id)
            return

        try:
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
                       SET current_step = %s::text,
                           scope = %s::jsonb,
                           cursor = %s::jsonb,
                           updated_at = NOW()
                     WHERE run_id = %s::uuid
                    """,
                    (step_id, json.dumps(scope), json.dumps(cursor), run_id),
                )
            await work_conn.commit()
        finally:
            # Release the session lock so the run is eligible for the next
            # advance cycle (or a peer replica). Best-effort; if the
            # connection is already broken the lock releases on session
            # close anyway.
            try:
                async with work_conn.cursor() as cur:
                    await cur.execute(
                        "SELECT pg_advisory_unlock(hashtext(%s), hashtext(%s::text))",
                        ("workflow_run_advance", run_id),
                    )
                await work_conn.commit()
            except Exception:
                log.exception("[workflow_engine] failed to release advisory lock for %s", run_id)

    async def _execute_step(
        self, step: dict[str, Any], scope: dict[str, Any],
    ) -> Any:
        kind = step.get("kind")
        if kind == "tool_call":
            return await self._exec_tool_call(step, scope)
        if kind == "wait":
            return await self._exec_wait(step, scope)
        if kind in ("conditional", "loop", "parallel", "sub_agent"):
            # MVP guard: these step kinds are accepted by the agent-side Zod
            # validator but the engine has no implementation yet. The previous
            # behaviour returned a no-op success which let workflows that
            # use them silently produce wrong results. Now we fail the run
            # explicitly so the agent / operator sees the gap.
            raise NotImplementedError(
                f"workflow step kind {kind!r} is not yet implemented in the engine; "
                f"add an _exec_{kind} handler before defining workflows that use it"
            )
        raise ValueError(f"unknown step kind: {kind!r}")

    async def _exec_tool_call(self, step: dict[str, Any], scope: dict[str, Any]) -> Any:
        if self._http is None:
            raise RuntimeError("http client not initialized")
        tool = step["tool"]
        args = step.get("args", {})
        url = self._tool_url(tool)
        # Mint a service-scoped JWT for the destination MCP service so the
        # workflow engine works against MCP_AUTH_REQUIRED=true clusters.
        # In dev mode (no signing key), no Authorization header is sent.
        service = self._tool_service(tool)
        token = self._token_cache.get(service=service, user_entra_id="__system__")
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        resp = await self._http.post(url, json=args, headers=headers)
        if resp.status_code >= 400:
            raise RuntimeError(f"{tool} → {resp.status_code}: {resp.text[:200]}")
        return resp.json()

    @staticmethod
    def _tool_service(tool: str) -> str:
        """Return the MCP service name (matches SERVICE_SCOPES key) for `tool`."""
        if tool.startswith("qm_crest"):
            return "mcp-crest"
        if tool.startswith("qm_"):
            return "mcp-xtb"
        if tool == "generate_focused_library" or tool.startswith("genchem_"):
            return "mcp-genchem"
        # Sensible default — services that don't map cleanly fall back to
        # mcp-xtb's scope, which is what the existing tool_url fallback used.
        return "mcp-xtb"

    async def _exec_wait(self, step: dict[str, Any], scope: dict[str, Any]) -> Any:
        spec = step.get("for", {})
        if "batch_id" in spec:
            # MVP: poll the batch row until total reached.
            batch_id = self._resolve_jmespath(spec["batch_id"], scope)
            # Default timeout is config-tunable (workflow_engine.default_wait_timeout_seconds);
            # per-step `timeout_seconds` still wins. Poll interval is also
            # config-tunable so operators can trade DB load for wait latency.
            default_timeout = self._config.get_int(
                "workflow_engine.default_wait_timeout_seconds", 3600,
            )
            timeout = int(step.get("timeout_seconds", default_timeout))
            poll_interval = max(
                1, self._config.get_int("workflow_engine.wait_poll_interval_seconds", 5)
            )
            poll_conn = await self._get_poll_conn()
            # autocommit=True on poll_conn means each SELECT runs in its own
            # implicit transaction; the connection itself is reused across
            # the whole timeout window instead of dialing a fresh socket
            # per poll.
            for _ in range(max(1, timeout // poll_interval)):
                async with poll_conn.cursor() as cur:
                    await cur.execute(
                        "SELECT total, succeeded, failed, cancelled FROM task_batches WHERE id = %s::uuid",
                        (batch_id,),
                    )
                    row = await cur.fetchone()
                if row is None:
                    raise RuntimeError(f"batch not found: {batch_id}")
                if row["succeeded"] + row["failed"] + row["cancelled"] >= row["total"]:
                    return dict(row)
                await asyncio.sleep(poll_interval)
            raise TimeoutError(f"wait on batch {batch_id} timed out")
        raise ValueError("only batch_id wait is implemented in MVP")

    async def _get_poll_conn(self) -> psycopg.AsyncConnection:
        if self._poll_conn is None or self._poll_conn.closed:
            self._poll_conn = await psycopg.AsyncConnection.connect(
                self.settings.dsn, autocommit=True, row_factory=dict_row,
            )
        return self._poll_conn

    @staticmethod
    def _resolve_jmespath(expr: str, scope: dict[str, Any]) -> Any:
        # JMESPath against scope. The DSL field documents this as JMESPath
        # since day one; pre-PR it was a hand-rolled dotted-path walker that
        # silently mis-evaluated any selector with brackets / filters / pipes
        # (e.g. `outputs[?status=='ok']` returned None instead of the matching
        # row). Drop the leading `scope.` prefix to preserve the dotted-path
        # call sites that legitimately rooted at scope; jmespath itself
        # treats `scope.foo` as `scope` then `.foo`, so the prefix would
        # always miss without a real `scope` key in the dict.
        if expr.startswith("scope."):
            expr = expr[len("scope."):]
        try:
            return jmespath.search(expr, scope)
        except jmespath.exceptions.JMESPathError:
            return None

    def _tool_url(self, tool: str) -> str:
        # Map tool id -> MCP HTTP endpoint. Extend as new tools land.
        urls = {
            "qm_single_point":  os.environ.get("MCP_XTB_URL", "http://mcp-xtb:8010") + "/single_point",
            "qm_geometry_opt":  os.environ.get("MCP_XTB_URL", "http://mcp-xtb:8010") + "/geometry_opt",
            "qm_frequencies":   os.environ.get("MCP_XTB_URL", "http://mcp-xtb:8010") + "/frequencies",
            "qm_fukui":         os.environ.get("MCP_XTB_URL", "http://mcp-xtb:8010") + "/fukui",
            "qm_redox_potential": os.environ.get("MCP_XTB_URL", "http://mcp-xtb:8010") + "/redox",
            "qm_crest_screen":  os.environ.get("MCP_CREST_URL", "http://mcp-crest:8014") + "/conformers",
            "generate_focused_library": os.environ.get("MCP_GENCHEM_URL", "http://mcp-genchem:8023") + "/scaffold_decorate",
        }
        if tool not in urls:
            raise ValueError(f"workflow_engine has no URL mapping for tool {tool!r}")
        return urls[tool]

    async def _append_event(
        self, work_conn: psycopg.AsyncConnection, run_id: str,
        kind: str, step_id: str | None, payload: dict[str, Any],
    ) -> None:
        # SEQ allocation is racy across replicas: SELECT MAX(seq)+1 at
        # READ COMMITTED with no row lock means two concurrent writers
        # for the same run_id can observe the same MAX and produce the
        # same seq — failing the (run_id, seq) UNIQUE constraint and
        # raising on the second INSERT.
        #
        # Take a transaction-scoped advisory lock keyed on the run_id
        # hash so writes for the same run serialise across replicas.
        # The lock is released automatically at COMMIT (advisory_xact)
        # so a crashed worker doesn't leak a held lock. hashtext yields
        # a 32-bit int suitable for the single-key pg_try_advisory_xact_lock
        # form; we use the two-key variant with 'workflow_events' as a
        # namespace constant so other code using advisory locks doesn't
        # collide.
        async with work_conn.cursor() as cur:
            await cur.execute(
                "SELECT pg_advisory_xact_lock(hashtext(%s), hashtext(%s::text))",
                ("workflow_events", run_id),
            )
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
                   SET status = %s,
                       finished_at = NOW(),
                       output = %s::jsonb
                 WHERE id = %s::uuid
                """,
                (status, json.dumps(outputs), run_id),
            )
            # Emit an ingestion_events row on success so KG projectors can
            # materialise workflow outputs (BACKLOG: A-on-C completeness).
            # Only succeeded runs emit; failures already surface via
            # workflow_events.kind='step_failed'/'finish' for the engine
            # observers, and we don't want failed runs to trigger downstream
            # KG materialisation. source_row_id carries the run id; payload
            # carries the run output for projector convenience.
            if status == "succeeded":
                await cur.execute(
                    """
                    INSERT INTO ingestion_events
                        (event_type, source_table, source_row_id, payload)
                    VALUES
                        ('workflow_run_succeeded', 'workflow_runs', %s::uuid, %s::jsonb)
                    """,
                    (run_id, json.dumps({"run_id": run_id, "outputs": outputs})),
                )
        await self._append_event(work_conn, run_id, "finish", None, {"status": status, "outputs": outputs})


def main() -> None:
    settings = EngineSettings()
    configure_logging(settings.log_level, service="workflow_engine")
    asyncio.run(WorkflowEngine(settings).run())


if __name__ == "__main__":
    main()
