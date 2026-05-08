# Python Capabilities of the Agent — Survey

**Branch:** `claude/investigate-python-capabilities-UPmyz`
**Date:** 2026-05-08
**Scope:** What Python code can the agent actually run today, how fast, and how does it command multi-step workflows.

This is a survey, not a fix. No code is changed; every claim is anchored to a `path:line`.

---

## TL;DR

| Question | Answer |
|---|---|
| Can the agent execute Python? | **Yes**, three distinct execution surfaces (`run_program`, `forge_tool` test phase, `run_orchestration_script`), plus implicit Python-backed MCP RPCs. |
| Is it fast? | **Cold-start dominated.** E2B `run_program` builds a fresh sandbox per call (~tens of seconds). Monty has a warm-pool implementation but it is **not wired at boot today** — every `run_orchestration_script` cold-spawns a child. |
| Can it drive multi-step workflows? | **Yes, three layers of orchestration**, but the most powerful layer (`workflow_engine`) is an MVP: only `tool_call` and `wait` step kinds are implemented; `conditional`, `loop`, `parallel`, `sub_agent` raise `NotImplementedError`. |
| Where does real composition happen today? | The **agent loop itself** + `manage_todos` + `agent_plans` + `dispatch_sub_agent` + `run_orchestration_script`. The Python-engine workflow path is the future replacement, not the current workhorse. |

---

## 1. Python-execution surfaces

### 1.1 `run_program` — arbitrary Python in E2B
- `services/agent-claw/src/tools/builtins/run_program.ts:54` — input schema (≤50 000 chars; `timeout_ms` clamped 1 000–30 000 ms).
- `services/agent-claw/src/tools/builtins/run_program.ts:288,340` — `sandboxClient.createSandbox()` → execute → `closeSandbox()`. **Single-use sandbox per call.**
- `services/agent-claw/src/core/sandbox.ts:51` — `SANDBOX_MAX_CPU_S` (default 30 s).
- `services/agent-claw/src/core/sandbox.ts:60` — egress disabled by default (`SANDBOX_ALLOW_NET_EGRESS`).
- `services/agent-claw/src/core/sandbox.ts:109` — real `e2b` SDK lazy-loaded; `E2B_API_KEY`/`E2B_TEMPLATE_ID` env-driven.
- `services/agent-claw/src/tools/builtins/run_program.ts:78-156` — auto-injects a `chemclaw` stub module exposing **6 helpers**: `fetch_document`, `query_kg`, `find_similar_reactions`, `canonicalize_smiles`, `embed_text`, `compute_drfp`. All other side-effects are blocked by network egress being off. Stub helpers use `urllib` with a hardcoded 15 s upstream timeout.
- Output is parsed from stdout via a `__chemclaw_output__` JSON marker (`run_program.ts:181-197`).
- **Arbitrary user code: yes. stdlib + `chemclaw` only.**

### 1.2 `forge_tool` / `induce_forged_tool_from_trace` — synthesise persistent Python tools
- `services/agent-claw/src/tools/builtins/forge_tool.ts:1-507` — Forjador pipeline: schemas + tests → LLM-drafted Python → execute every test in E2B → on-pass persists `<uuid>.py` to `FORGED_TOOLS_DIR` and writes `skill_library` (`kind='forged_tool'`, shadowed 14 days), `tools`, `forged_tool_tests`.
- `forge_tool.ts:85` — refuses to forge `forge_tool` or `run_program` (loop guard).
- `forge_tool.ts:361` — per-test timeout 20 s.
- `services/agent-claw/src/tools/registry.ts:454-551` — at call-time a forged tool is read from disk, **SHA-256 verified**, mounted into a fresh E2B sandbox with the same `chemclaw` stub, executed.
- `services/agent-claw/src/tools/builtins/induce_forged_tool_from_trace.ts` — reads a Langfuse trace, generalises tool-call sequence into a spec, delegates to `forge_tool`. Same execution path.
- **Arbitrary user code: yes (during test phase + every subsequent dispatch).** Promotion is gated by all tests passing on golden + held-out (Phase E).
- `services/agent-claw/src/tools/builtins/add_forged_tool_test.ts` — appends a test row; **no execution at append time** (re-validation happens on next `forge_tool`).

### 1.3 `run_orchestration_script` — Monty-runtime "code mode"
- `services/agent-claw/src/tools/builtins/run_orchestration_script.ts:52,66` — script ≤50 000 chars; timeout 1 000–600 000 ms.
- `services/agent-claw/src/tools/builtins/run_orchestration_script.ts:142-172` — disabled unless `monty.binary_path` is set; falls through to unsafe `exec()` only if `MONTY_RUNNER_ALLOW_UNSAFE_EXEC=1` AND not in production (`tools/cli/monty-runner.py:13-33`).
- `services/agent-claw/src/runtime/monty/limits.ts:30,56,71` — `monty.warm_pool_size` (default 4, clamped 0–32) + `monty.wall_time_ms` (default 30 000, clamped 1 000–600 000).
- `services/agent-claw/src/runtime/monty/pool.ts:6-7,99-152` — single-use children, pre-spawned, replays "ready" frame on acquire.
- `services/agent-claw/src/runtime/monty/host.ts:32` — `READY_TIMEOUT_MS=5000`.
- `services/agent-claw/src/runtime/monty/child-adapter.ts:92` — spawns the binary.
- The script can call `external_function(tool_id, args)`. Each call is preflight-checked against an explicit `allowed_tools` list at the route, then routed through the **full `runOneTool` pipeline** (permission resolver, `pre_tool` hook, execution, `post_tool` hook).
- **Arbitrary user code: yes, Rust-isolated when Monty binary is present; unsafe `exec()` is dev-only.**

> **Latency caveat (verified):** `services/agent-claw/src/bootstrap/dependencies.ts:382-390` registers `run_orchestration_script` **without a `pool`**. The `WarmChildPool` exists in code but is not instantiated at boot today, so every script cold-spawns a child. Wiring the pool is a small change with a real latency win for chained code-mode steps — see "Improvement opportunities" below.

### 1.4 Implicit Python via MCP services
The agent fires Python **indirectly** every time it calls an MCP service. These are not arbitrary execution — fixed endpoints, parametrised inputs — but they are the load-bearing scientific compute path.

| Service | Port | Backbone |
|---|---|---|
| `mcp_rdkit` | 8001 | RDKit |
| `mcp_drfp` | 8002 | DRFP |
| `mcp_kg` | 8003 | Neo4j driver |
| `mcp_embedder` | 8004 | BGE-M3 |
| `mcp_doc_fetcher` | 8006 | Marker / ChemDataExtractor |
| `mcp_askcos` | 8007 | askcos2 |
| `mcp_aizynth` | 8008 | aizynth-finder |
| `mcp_chemprop` | 8009 | chemprop |
| `mcp_xtb` | 8010 | xtb (workflow recipes only) |
| `mcp_synthegy_mech` | 8011 | LLM A* mechanism elucidation |
| `mcp_sirius` | 8012 | sirius |
| `mcp_eln_local` | 8013 | mock ELN |
| `mcp_logs_sciy` | 8016 | LOGS-by-SciY adapter |

Auth: HS256 JWT minted per call by `services/agent-claw/src/security/mcp-tokens.ts`, cached ~4 min in `services/agent-claw/src/security/mcp-token-cache.ts:51-87`. HTTP timeout is per-call (typically 15 s for fast tools, up to ~1 800 s server-side for xtb workflows).

### 1.5 Python that the agent does **not** execute directly
- **Projectors** (`services/projectors/*/main.py`) react to `NOTIFY ingestion_events` / custom channels. The agent triggers them only by writing rows that fire NOTIFY (e.g. `INSERT INTO mock_eln.experiments` → projector picks up). Async, fire-and-forget.
- **`workflow_engine`** (next section) — agent triggers via DB row, engine executes Python steps in another process.
- **`session_reanimator`** — polling daemon, calls back into the agent's HTTP API; the agent never calls it.

---

## 2. Latency story

| Path | First call | Warm call | Notes |
|---|---|---|---|
| `run_program` (E2B) | ~tens of seconds (sandbox spin-up bounded by `SANDBOX_MAX_CPU_S + 10` = 40 s) | **Same as first** — sandbox is destroyed at end of call (`run_program.ts:340`) | No pool. Each call is independent. |
| `forge_tool` test phase | E2B cold-start × N tests (20 s ceiling each) | N/A — per-forge | Sequential, not batched. |
| Forged-tool dispatch | E2B cold-start | Same as first | SHA-256 re-verified each call. |
| `run_orchestration_script` (Monty) | Cold-spawn child + ready handshake (≤5 s) + script time | **Same as first today** — pool not instantiated (`dependencies.ts:382`) | If the pool were wired, warm acquire is microseconds. |
| MCP HTTP RPC | Service-dependent; usually <1 s for retrieval, longer for compute | Service-dependent | JWT cache amortises auth cost. |
| Python in projectors | N/A (background) | N/A | Bounded by `pg_notify` pickup + projector handler latency. |

**Streaming:** None of the Python paths stream stdout/stderr to the agent. Buffers fill, the call returns, the agent sees the full result. This is fine for short scripts, painful for long-running compute.

**Concurrency:**
- `run_program`: bounded only by E2B account quota; the agent itself imposes no per-user cap.
- Monty: would be bounded by pool size if wired (currently bounded only by node-process limits since pool is unused).
- MCP services: bounded by uvicorn worker count per container.

---

## 3. Multi-step control: three layers, three speeds

The agent has **three orthogonal mechanisms** for multi-step orchestration. They are not redundant — each occupies a different point on the control / latency / durability axis.

### Layer A — In-loop ReAct
The agent's own while-loop. Each turn: LLM picks a tool, harness executes it, result feeds the next turn. Steps are tracked in scratchpad, persisted at end of turn (`services/agent-claw/src/core/session-state.ts`).

**Tools that compose multi-step intent inside the loop:**
- **`manage_todos`** (`services/agent-claw/src/tools/builtins/manage_todos.ts`, schema `db/init/13_agent_sessions.sql:53-71`) — DB-backed checklist. Actions: `create`, `update`, `complete`, `cancel`, `list`. Lifecycle hook `task_created` / `task_completed` fires. SSE `todo_update` updates the UI. The reanimator uses `EXISTS (in_progress todos)` as a resume signal.
- **`ask_user`** (`services/agent-claw/src/tools/builtins/ask_user.ts`) — pauses the harness; persists the redacted question to `agent_sessions.awaiting_question`; ends the SSE stream. Resume = next user message on the same session_id.
- **`dispatch_sub_agent`** (`services/agent-claw/src/tools/builtins/dispatch_sub_agent.ts` + `services/agent-claw/src/core/sub-agent.ts`) — fans work out to a typed sub-harness (`chemist`, `analyst`, `reader`) with a restricted tool subset. Citations are merged back into the parent's `seenFactIds` so the parent doesn't re-reject grounded facts. No explicit recursion-depth limit; per-agent budget (~10 max steps, ~40 k prompt tokens) is the de-facto bound.

**Latency:** as fast as the LLM call + tool. Sub-agents add ≥1 LLM call.
**Durability:** scratchpad + todos persisted; mid-run crash drops the in-progress turn but the session can be resumed.

### Layer B — DB-backed plan with chained execution
- **`agent_plans`** schema: `db/init/14_agent_session_extensions.sql:72-127`.
- A plan is a list of `PlanStep { step_number, tool, args, rationale }`.
- Lifecycle: `proposed → approved → running → completed | cancelled | failed`.
- **Approval flow:** propose via plan-mode preview; `POST /api/chat/plan/approve` flips status; `POST /api/sessions/:id/plan/run` starts the chained loop.
- **Chained harness:** `services/agent-claw/src/core/chained-harness.ts` — runs up to `AGENT_PLAN_MAX_AUTO_TURNS` (default 10) iterations. Each iteration synthesises a "Continue with next step" turn, calls `runHarness`, advances `current_step_index` if the called tool matches the next planned step, and exits on `stop`, budget exhaustion, `ask_user`, or cap.
- **Token budget:** `agent_sessions.session_token_budget` + `session_input_tokens` / `session_output_tokens` (cross-turn accumulator).
- **Auto-resume:** `services/optimizer/session_reanimator/main.py` polls every 5 min, finds sessions with `last_finish_reason ∈ {max_steps, stop}` + `EXISTS in_progress todos` + `auto_resume_count < auto_resume_cap` (default 10), POSTs `/api/internal/sessions/:id/resume` with an HS256 JWT (`agent:resume` scope).

**Latency:** human-scale — chained turns are sequential LLM calls.
**Durability:** the plan, the todos, and the cross-turn budget are all in Postgres + RLS. Crashes lose only the in-flight turn.

### Layer C — `workflow_engine` (event-sourced, MVP)
- **Schema:** `db/init/29_workflows.sql` — `workflows`, `workflow_runs`, `workflow_events` (append-only), `workflow_state` (materialised cursor).
- **NOTIFY:** `pg_notify('workflow_event', '<run_id>:<seq>')` on every `workflow_events` insert (`db/init/29_workflows.sql:76-86`).
- **Engine:** `services/workflow_engine/main.py:68-450`. LISTEN on `workflow_event`; periodic sweep; `FOR UPDATE SKIP LOCKED` + `pg_try_advisory_lock` per run for replica safety.
- **Step kinds (verified at `main.py:256-275`):**
  - ✅ `tool_call` — HTTP POST to MCP service with service-scoped JWT.
  - ✅ `wait` — block on a `batch_id` until all tasks resolve (uses a dedicated long-lived poll connection).
  - ❌ `conditional`, `loop`, `parallel`, `sub_agent` — **all four raise `NotImplementedError`.** The previous "no-op success" was hardened to fail loudly so workflows that use them don't silently produce wrong results.
- **Agent triggers:** `services/agent-claw/src/tools/builtins/workflow_run.ts` (start a run by `workflow_id` + `input`), `workflow_define.ts`, `workflow_modify.ts`, `workflow_inspect.ts`, `workflow_pause_resume.ts`, `workflow_replay.ts`, `promote_workflow_to_tool.ts`. `run_xtb_workflow.ts` is a legacy bridge to `mcp-xtb /run_workflow` and bypasses the engine.
- **Completion side-effect:** on success the engine emits an `ingestion_events` row (`source_table='workflow_runs'`) so the KG projectors pick up the result.

**Latency:** event-driven, no agent in the hot path. Step granularity = single MCP call (~seconds–minutes).
**Durability:** strongest of the three. Append-only event log → exact replay. Advisory locks prevent dual-execution across replicas.
**Today's gap:** without `conditional` / `loop` / `parallel`, the engine can only run **straight-line MCP pipelines**. Anything involving branching or fan-out has to fall back to Layer A or Layer B.

---

## 4. End-to-end picture

A user prompt that requires multi-step action moves through the layers like this:

```
USER → /api/chat (or /api/sessions/:id/plan/run)
  ↓
hydrateScratchpad (session_id), build ToolContext
  ↓
pre_turn hooks: apply-skills (skill prompts + tool filter), init-scratch
  ↓
runHarness — single ReAct loop
  ↓
Agent picks tools:

  • manage_todos.create([5 steps])          — Layer A intent capture
  • dispatch_sub_agent(type=chemist, ...)   — Layer A fan-out, citations merged back
  • run_orchestration_script(py, allowed)   — Pythonic mid-flight composition (Monty)
  • run_program(py)                         — quick numeric/string Python (E2B)
  • forge_tool(...) / use forged tool       — promote a recurring pattern to a tool
  • workflow_run(workflow_id, input)        — Layer C: hand off to engine, return run_id
       ↓
       workflow_engine LISTEN/sweep → tool_call / wait → events → ingestion_events → projectors → KG/vector
  ↓
persistTurnState — scratchpad, last_finish_reason, token counters
  ↓
If chained: runChainedHarness loops until plan complete / budget / ask_user / cap.
If stalled: session_reanimator (5-min poll) POSTs /api/internal/sessions/:id/resume.
```

**Shortest path** (low latency, no durability needed): in-loop `run_program` for a few-line Python computation.
**Medium path** (durable plan, agent in the loop): `agent_plans` + `manage_todos` + chained-harness + reanimator.
**Strongest path** (durable, replicated, replayable, agent out of loop after launch): `workflow_run` → `workflow_engine` — but only for straight-line `tool_call` + `wait` chains today.

---

## 5. Verified findings worth flagging

1. **Workflow engine MVP is narrower than CLAUDE.md suggests.** CLAUDE.md mentions "currently only `tool_call` + `wait`"; the code (`main.py:264-273`) confirms `conditional`, `loop`, `parallel`, `sub_agent` all raise `NotImplementedError`. The Zod validator on the agent side accepts these kinds, so a defined workflow can pass validation and still fail at execution. (Documented behaviour — failure is now loud rather than silent.)
2. **Monty warm pool is dead code at boot.** `WarmChildPool` exists, is exported, has tests. `dependencies.ts:382-390` registers `run_orchestration_script` without a `pool`, so every code-mode call cold-spawns a child. This is the single biggest latency lever on the Python-execution side.
3. **No streaming on any Python path.** `run_program`, `run_orchestration_script`, MCP HTTP — all buffer until completion. Long-running Python (xtb, optimisation campaigns) returns nothing to the agent until done.
4. **`run_program`'s `chemclaw` stub is the only egress.** Network egress is off by default; the stub exposes 6 helpers via 15 s `urllib` calls. Anything else (file I/O outside `/tmp`, package install, network) is blocked at the sandbox level.
5. **Forged-tool dispatch re-reads from disk every call.** SHA-256 verification on every call (`registry.ts:501-519`) is a tamper-resistance feature, but it is also a per-call I/O cost; not cached.
6. **Auto-resume is bounded but not idempotent across budget / cap.** `auto_resume_cap` (default 10) caps runaway resumes. If a workflow needs more than 10 cycles of "stop → reanimate → continue", an admin has to bump the cap.

---

## 6. Improvement opportunities (ranked by effort × impact)

| Idea | Effort | Impact |
|---|---|---|
| Wire `WarmChildPool` in `dependencies.ts` so `run_orchestration_script` doesn't cold-spawn each call | XS (a few lines) | Big latency win for code-mode chains |
| Implement `_exec_conditional` in `workflow_engine` (JMESPath branch already designed) | S | Unblocks branching workflows, the most-requested missing kind |
| Stream stdout/stderr from E2B / Monty back through SSE during execution | M | UX win for long Python computations; also helps debugging |
| Implement `_exec_parallel` (asyncio.gather over the existing single-step path) | M | Fan-out without sub_agent |
| Implement `_exec_sub_agent` so a workflow step can spawn a `dispatch_sub_agent` | M | Lets workflows pull LLM reasoning into deterministic plumbing |
| Cache forged-tool source by `code_sha256` to skip per-call disk read | XS | Modest latency improvement; preserves tamper-detection (verify-on-load + cache) |
| Persistent E2B template / pool for `run_program` | M | Larger latency win; needs an E2B-side strategy |
| Promote a `workflow_run + wait + ingestion_events` shorthand to a single agent tool | S | Reduces agent turns for the common "kick a workflow and wait for the KG" pattern |

---

## 7. References (one-stop file map)

- **Agent harness:** `services/agent-claw/src/core/runtime.ts`, `services/agent-claw/src/core/chained-harness.ts`, `services/agent-claw/src/core/session-state.ts`.
- **Sandbox:** `services/agent-claw/src/core/sandbox.ts`.
- **Builtins (Python-relevant):** `services/agent-claw/src/tools/builtins/run_program.ts`, `run_orchestration_script.ts`, `forge_tool.ts`, `induce_forged_tool_from_trace.ts`, `add_forged_tool_test.ts`, `dispatch_sub_agent.ts`, `manage_todos.ts`, `ask_user.ts`, `workflow_run.ts`, `workflow_define.ts`, `workflow_inspect.ts`, `workflow_modify.ts`, `workflow_pause_resume.ts`, `workflow_replay.ts`, `promote_workflow_to_tool.ts`.
- **Monty runtime:** `services/agent-claw/src/runtime/monty/` (`limits.ts`, `pool.ts`, `host.ts`, `child-adapter.ts`).
- **Workflow engine:** `services/workflow_engine/main.py`, `db/init/29_workflows.sql`.
- **Sessions / plans / reanimator:** `db/init/13_agent_sessions.sql`, `db/init/14_agent_session_extensions.sql`, `services/optimizer/session_reanimator/main.py`.
- **MCP services (Python):** `services/mcp_tools/mcp_rdkit/`, `mcp_drfp/`, `mcp_kg/`, `mcp_embedder/`, `mcp_doc_fetcher/`, `mcp_askcos/`, `mcp_aizynth/`, `mcp_chemprop/`, `mcp_xtb/`, `mcp_synthegy_mech/`, `mcp_sirius/`, `mcp_eln_local/`, `mcp_logs_sciy/`.
