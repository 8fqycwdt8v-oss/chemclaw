"""workflow_engine — executes workflow runs.

Consumes `pg_notify('workflow_event', run_id:seq)` and dispatches the next
runnable step. The canonical state of a run is the fold of `workflow_events`;
`workflow_state` is a materialized projection rebuildable at any time.

Step kinds supported:
  - tool_call   — invoke an MCP service via HTTP (mcp-xtb, mcp-genchem, …)
  - sub_agent   — spawn an agent-claw sub-agent via the internal endpoint
  - conditional — pick branch by JMESPath expr against scope
  - parallel    — fan-out substeps via asyncio.gather (concurrency-capped)
  - loop        — iterate `body` over `for_each` items, sequential or parallel
  - wait        — block on a batch_id until all tasks resolve

Failure semantics: a step_failed event is appended; the workflow status
moves to 'failed' and the run is finalized.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import signal
from typing import Any

import httpx
import jmespath
import psycopg
from psycopg.rows import dict_row
from pydantic_settings import BaseSettings, SettingsConfigDict

from services.common.config_registry import ConfigRegistry
from services.mcp_tools.common.auth import McpAuthError, sign_mcp_token
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
        if kind == "conditional":
            return await self._exec_conditional(step, scope)
        if kind == "parallel":
            return await self._exec_parallel(step, scope)
        if kind == "sub_agent":
            return await self._exec_sub_agent(step, scope)
        if kind == "loop":
            return await self._exec_loop(step, scope)
        raise ValueError(f"unknown step kind: {kind!r}")

    async def _exec_conditional(
        self, step: dict[str, Any], scope: dict[str, Any],
    ) -> Any:
        """Branch step: evaluate `if` (JMESPath against scope) for truthiness;
        execute either `then` or `else` substep. Both branches accept a single
        nested step dict; absent branches are no-ops returning None.

        Step shape:
            {kind: 'conditional', if: '<jmespath>', then: <step>, else?: <step>}
        """
        expr = step.get("if")
        if not isinstance(expr, str) or not expr:
            raise ValueError("conditional step requires non-empty 'if' (JMESPath string)")
        value = self._resolve_jmespath(expr, scope)
        chosen = step.get("then") if value else step.get("else")
        if chosen is None:
            return {"branch": "then" if value else "else", "result": None}
        if not isinstance(chosen, dict):
            raise ValueError(
                f"conditional 'then'/'else' must be a step dict, got {type(chosen).__name__}"
            )
        result = await self._execute_step(chosen, scope)
        return {"branch": "then" if value else "else", "result": result}

    async def _exec_parallel(
        self, step: dict[str, Any], scope: dict[str, Any],
    ) -> Any:
        """Fan-out step: run all substeps concurrently via asyncio.gather.
        Returns a list of substep results in input order. If any substep
        raises, the whole parallel step fails — pre-PR loop / parallel
        absence forced this serialization onto the agent loop.

        Step shape:
            {kind: 'parallel', steps: [<step>, ...], max_concurrency?: int}

        Concurrency note: substeps share `scope` by reference. Today's
        _exec_* handlers only READ scope, so this is safe under
        asyncio.gather. A future handler that mutates scope (e.g. to
        propagate a substep result during execution) would race — at
        that point, either deep-copy per substep or serialize the writes.
        """
        substeps = step.get("steps")
        if not isinstance(substeps, list) or not substeps:
            raise ValueError("parallel step requires non-empty 'steps' list")
        for i, sub in enumerate(substeps):
            if not isinstance(sub, dict):
                raise ValueError(
                    f"parallel substep [{i}] must be a step dict, got {type(sub).__name__}"
                )

        # max_concurrency defaults to the substep count (no throttle). Cap
        # via config so a runaway workflow can't open hundreds of HTTP
        # sockets to a single MCP service.
        config_cap = max(
            1,
            self._config.get_int("workflow_engine.parallel_max_concurrency", 16),
        )
        requested = step.get("max_concurrency")
        if isinstance(requested, int) and requested > 0:
            cap = min(requested, config_cap)
        else:
            cap = config_cap
        cap = min(cap, len(substeps))

        sem = asyncio.Semaphore(cap)

        async def _run_one(sub: dict[str, Any]) -> Any:
            async with sem:
                return await self._execute_step(sub, scope)

        results = await asyncio.gather(*(_run_one(s) for s in substeps))
        return list(results)

    async def _exec_loop(
        self, step: dict[str, Any], scope: dict[str, Any],
    ) -> Any:
        """Iterative step: resolve `for_each` to a list, execute `body` once
        per item, collect results in input order.

        Step shape:
            {kind: 'loop', for_each: '<jmespath>', body: <step>,
             mode?: 'sequential'|'parallel', max_concurrency?: int}

        Each iteration sees a per-iteration scope copy with `loop` =
        {'item': <item>, 'index': <i>}. Body steps reference the
        iteration via that key (e.g. conditional `if: 'loop.item.score > \\`0.5\\`'`,
        sub_agent `goal: '${loop.item.smiles}'`).

        Sequential mode (default) runs iterations one after another and
        propagates the first failure. Parallel mode runs under a semaphore
        whose cap is the min of step.max_concurrency,
        config_settings.workflow_engine.loop_max_concurrency, and len(items).

        An empty `for_each` result returns [] without raising. A null result
        (JMESPath miss) is treated as []; misuse — a non-list result —
        raises so workflow authors notice.
        """
        # Validate the structural fields (for_each, body, mode) before
        # touching scope, so a malformed step always raises the same
        # ValueError regardless of what scope happens to contain.
        expr = step.get("for_each")
        if not isinstance(expr, str) or not expr:
            raise ValueError("loop step requires non-empty 'for_each' (JMESPath string)")

        body = step.get("body")
        if not isinstance(body, dict):
            raise ValueError("loop step requires 'body' step dict")

        mode = step.get("mode", "sequential")
        if mode not in ("sequential", "parallel"):
            raise ValueError(
                f"loop 'mode' must be 'sequential' or 'parallel', got {mode!r}"
            )

        items = self._resolve_jmespath(expr, scope)
        if items is None:
            items = []
        if not isinstance(items, list):
            raise ValueError(
                f"loop 'for_each' must resolve to a list, got {type(items).__name__}"
            )

        if not items:
            return []

        async def _run_iteration(index: int, item: Any) -> Any:
            # Shallow-copy the outer scope so the loop var doesn't leak
            # into subsequent steps. Substeps that READ scope see both
            # outer state and `loop`. Substeps that WRITE would race
            # under parallel mode; today's _exec_* handlers only read
            # (parallel.steps and conditional.then/else share the same
            # constraint).
            iter_scope = dict(scope)
            iter_scope["loop"] = {"item": item, "index": index}
            return await self._execute_step(body, iter_scope)

        if mode == "parallel":
            config_cap = max(
                1,
                self._config.get_int("workflow_engine.loop_max_concurrency", 16),
            )
            requested = step.get("max_concurrency")
            if isinstance(requested, int) and requested > 0:
                cap = min(requested, config_cap)
            else:
                cap = config_cap
            cap = min(cap, len(items))
            sem = asyncio.Semaphore(cap)

            async def _gated(index: int, item: Any) -> Any:
                async with sem:
                    return await _run_iteration(index, item)

            return list(
                await asyncio.gather(
                    *(_gated(i, it) for i, it in enumerate(items))
                )
            )

        # sequential — first failure propagates immediately
        results: list[Any] = []
        for index, item in enumerate(items):
            results.append(await _run_iteration(index, item))
        return results

    async def _exec_sub_agent(
        self, step: dict[str, Any], scope: dict[str, Any],
    ) -> Any:
        """Spawn an agent-claw sub-agent via the internal sub_agent endpoint.

        Step shape:
            {kind: 'sub_agent', goal: '<text>', user_entra_id: '<id>',
             type?: 'chemist'|'analyst'|'reader',
             max_steps?: int, timeout_seconds?: int}

        The engine mints a service JWT (scopes=['agent:sub_agent']) and POSTs
        to AGENT_INTERNAL_BASE_URL + '/api/internal/workflows/sub_agent'. The
        endpoint runs the harness with a restricted tool subset and returns
        the final assistant text + citations + step count.
        """
        # Argument validation runs first so malformed workflows surface as
        # ValueError (workflow-author signal) rather than RuntimeError
        # ("engine not initialised"), matching the other _exec_* handlers.
        goal = step.get("goal")
        if not isinstance(goal, str) or not goal.strip():
            raise ValueError("sub_agent step requires non-empty 'goal' string")
        # JMESPath substitution. Two shapes supported:
        #
        # 1. Whole-string: goal is exactly '${expr}'. Resolves against scope;
        #    the resolved value must be a non-empty string.
        # 2. Substring: any number of '${expr}' tokens embedded in surrounding
        #    text, e.g. 'look up ${steps.first.smiles} and report ${steps.foo.id}'.
        #    Each match is resolved independently; non-string results are
        #    str()-cast (so a numeric step output naturally inlines).
        if goal.startswith("${") and goal.endswith("}") and goal.count("${") == 1:
            # Whole-string path preserves the prior strict contract: resolved
            # value must already be a string. Catches typos that would
            # otherwise produce a stringified None / dict.
            resolved = self._resolve_jmespath(goal[2:-1], scope)
            if not isinstance(resolved, str) or not resolved.strip():
                raise ValueError(
                    f"sub_agent goal expression {goal!r} did not resolve to a non-empty string"
                )
            goal = resolved
        elif "${" in goal:
            # Substring path. Each ${expr} is resolved independently; missing /
            # null results inline as the empty string (caller can chain with
            # COALESCE in the JMESPath itself if they want a default).
            def _sub(match: "re.Match[str]") -> str:
                expr = match.group(1)
                value = self._resolve_jmespath(expr, scope)
                if value is None:
                    return ""
                return str(value)

            substituted = re.sub(r"\$\{([^}]+)\}", _sub, goal)
            if not substituted.strip():
                raise ValueError(
                    f"sub_agent goal {goal!r} resolved to an empty/whitespace string after substitution"
                )
            goal = substituted

        user_entra_id = step.get("user_entra_id")
        if not isinstance(user_entra_id, str) or not user_entra_id.strip():
            raise ValueError(
                "sub_agent step requires 'user_entra_id' (engine has no ambient "
                "user context — workflow author must specify whose RLS scope to use)"
            )

        agent_type = step.get("type", "analyst")
        if agent_type not in ("chemist", "analyst", "reader"):
            raise ValueError(
                f"sub_agent 'type' must be one of chemist/analyst/reader, got {agent_type!r}"
            )

        max_steps = step.get("max_steps", 10)
        if not isinstance(max_steps, int) or max_steps < 1 or max_steps > 50:
            raise ValueError("sub_agent 'max_steps' must be int in [1, 50]")

        sub_inputs = step.get("inputs", {})
        if not isinstance(sub_inputs, dict):
            raise ValueError(
                f"sub_agent 'inputs' must be a dict, got {type(sub_inputs).__name__}"
            )

        timeout_seconds = step.get(
            "timeout_seconds",
            self._config.get_int("workflow_engine.sub_agent_timeout_seconds", 300),
        )

        if self._http is None:
            raise RuntimeError("http client not initialized")

        base_url = os.environ.get(
            "AGENT_INTERNAL_BASE_URL", "http://agent-claw:3101",
        )
        url = f"{base_url.rstrip('/')}/api/internal/workflows/sub_agent"

        # Mint a sub_agent-scoped JWT keyed to the workflow author's user.
        # The endpoint validates scope (`agent:sub_agent`) and audience
        # (`agent-claw`); on success it uses claims.user as the RLS scope.
        # In dev mode (no signing key) we fall back to x-user-entra-id, the
        # same back-compat shim the reanimator uses.
        signing_key = os.environ.get("MCP_AUTH_SIGNING_KEY", "").strip()
        headers: dict[str, str] = {}
        if signing_key:
            try:
                token = sign_mcp_token(
                    sandbox_id="workflow-engine",
                    user_entra_id=user_entra_id,
                    scopes=["agent:sub_agent"],
                    audience="agent-claw",
                    ttl_seconds=300,
                    signing_key=signing_key,
                )
            except McpAuthError as exc:
                raise RuntimeError(
                    f"sub_agent: failed to mint token: {exc}"
                ) from exc
            headers["Authorization"] = f"Bearer {token}"
        else:
            headers["x-user-entra-id"] = user_entra_id

        payload = {
            "goal": goal,
            "user_entra_id": user_entra_id,
            "type": agent_type,
            "max_steps": max_steps,
            "inputs": sub_inputs,
        }
        try:
            resp = await self._http.post(
                url, json=payload, headers=headers, timeout=timeout_seconds,
            )
        except httpx.TimeoutException as exc:
            raise TimeoutError(
                f"sub_agent step timed out after {timeout_seconds}s"
            ) from exc

        if resp.status_code >= 400:
            raise RuntimeError(
                f"sub_agent → {resp.status_code}: {resp.text[:500]}"
            )
        return resp.json()

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
