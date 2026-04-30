# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Required workflow for any non-trivial change

This repository often has multiple parallel sessions touching the same checkout. To avoid stomping on each other's files (this has bitten us — see git reflog for resets that wiped in-progress work), **always**:

1. **Start with `superpowers:using-git-worktrees`** — create a dedicated worktree (`git worktree add ../chemclaw-<task>`) for the task, on its own branch off `main`. Do all file edits there. The shared checkout is reserved for whatever the user is doing interactively.
2. **Use `superpowers:brainstorming` → `superpowers:writing-plans` → `superpowers:executing-plans`** (or `superpowers:subagent-driven-development`) for anything bigger than a one-line edit. Don't shortcut into code.
3. **Finish with `superpowers:finishing-a-development-branch`** — it presents merge / PR / cleanup options, removes the worktree, and ends the work cleanly. Don't leave orphan worktrees or half-merged branches behind.

When you skip step 1 and the parent checkout's branch flips under you, your files vanish and you re-do work. Don't.

## What ChemClaw is

Autonomous knowledge-intelligence agent for pharmaceutical chemical & analytical development. The central artifact is a **living bi-temporal knowledge graph** of compounds / reactions / experiments / conditions / documents with confidence-scored edges and explicit contradiction handling. Vector search is a complementary layer, not a replacement. The system is designed to act **proactively** (new data triggers autonomous investigation + outbound chat notifications) and to use scientific tools autonomously (RDKit, DFT, GFN2-xTB, TabPFN, etc.).

The authoritative design document is at `~/.claude/plans/chemos-knowledge-intelligence-tranquil-marshmallow.md`. Read it when making non-trivial changes — it contains the full ontology, schema design, retrieval architecture, self-improvement flow, and phased roadmap. Architecture decisions are summarized in `docs/adr/001-architecture.md`.

## The architectural pattern that matters most: A-on-C event-sourced ingestion

Ingestion writes **canonical records to Postgres first**, which emits events via `NOTIFY ingestion_events`. **Projectors** (stateless Python workers in `services/projectors/*`) subscribe via `LISTEN` and derive views: KG nodes/edges in Neo4j (via Graphiti), vector collections in pgvector, reaction DRFP vectors, etc. The agent reads these derived views at query time.

This pattern is load-bearing — follow it when adding new data types:

1. Add a canonical table in `db/init/01_schema.sql`.
2. Have the ingesting worker `INSERT` the row and emit an `ingestion_events` row with a typed `event_type` (the trigger `notify_ingestion_event` fires `NOTIFY` automatically).
3. Add a subclass of `BaseProjector` (`services/projectors/common/base.py`) that declares the `event_type`(s) it handles. Acknowledgment via `projection_acks` makes projectors safely replayable.

**Never update a derived view without an event.** Full KG / vector rebuilds are just `DELETE FROM projection_acks WHERE projector_name=X` — the projector re-derives from the event log.

## Control flow philosophy: autonomous by default, graph-coded where reproducibility is non-negotiable

- **Agent reasoning loop**: pure ReAct. Model picks tools. No DAG. The agent lives in `services/agent-claw/` (TypeScript, custom ~500-LOC harness — Mastra dropped under greenfield permission in Phase A). Port 3101.
- **Tools** (retrieval, KG ops, scientific compute, source systems): exposed as MCP/REST endpoints the agent calls. All Python services; TypeScript builtins wrap them via typed McpClient.
- **Plumbing** (ingestion, projectors, correction propagation): deterministic, rule-based. Never put LLM reasoning into these paths.
- **Skills, DR, and cross-project learning** are skill packs the agent chooses to invoke, not fixed pipelines. See `skills/` at repo root.

## Backend stack — why it looks the way it does

- **Python for scientific tools** (every MCP tool is Python): RDKit, Marker, ChemDataExtractor, DRFP, TabPFN, nmrglue, pyopenms have no TypeScript equivalents of comparable quality.
- **Node.js/TypeScript for orchestration** (agent-claw, Paperclip-lite): better async model, cleaner tool schema typing. Mastra dropped — replaced by ~500-LOC custom harness.
- **MCP is the cross-language boundary** — tools never import each other's code directly; everything is JSON over HTTP.
- **Paperclip-lite** (Node.js, ~500 LOC) handles heartbeat + budget + per-user concurrency. No GxP features.
- **Graphiti + Neo4j Community** for the bi-temporal KG. GPL-3.0 server-side only, no binary redistribution.
- **pgvector + pgvectorscale on the app Postgres** — one DB for state + vectors.

## Key commands

### Setup and infrastructure

```bash
cp .env.example .env            # once; edit secrets
make setup                      # .venv + Python deps + node deps (idempotent)
make up                         # Postgres + Neo4j
make up.full                    # all services including mcp-rdkit / mcp-drfp / reaction-vectorizer
make ps                         # show running
make down                       # stop (volumes preserved)
make nuke                       # stop AND drop volumes (destructive)
```

### Data

```bash
make db.psql                    # interactive psql as chemclaw user
make db.init                    # re-apply schema (idempotent)
make db.seed                    # sample NCE projects + dev user access
make import.sample              # import sample ELN JSON
```

### Running individual services locally

```bash
make run.agent                   # http://localhost:3101
chemclaw chat "..."              # CLI wrapper (tools/cli/README.md). The Streamlit frontend was moved to a separate repo.
make run.mcp-rdkit               # http://localhost:8001
make run.mcp-drfp                # http://localhost:8002
make run.reaction-vectorizer     # LISTEN/NOTIFY projector
```

### Quality and testing

```bash
make lint                       # ruff + eslint
make format                     # ruff format + eslint --fix
make typecheck                  # mypy + tsc
make test                       # pytest + vitest

# Single test file (no activation needed):
.venv/bin/pytest tests/unit/test_redactor.py -v

# Single test case:
.venv/bin/pytest tests/unit/test_redactor.py::test_redaction_is_deterministic -v

# TypeScript single test:
npm run test --workspace services/agent-claw -- tests/unit/some.test.ts
```

### Smoke test

```bash
./scripts/smoke.sh              # end-to-end: up → import → verify DRFP vectors populate
```

## Directory conventions

- **Python packages use `_` (underscores) in directory names** (`services/mcp_tools/`, `services/mcp_rdkit/`), because hyphens are illegal in Python package identifiers.
- **Container/service names in `docker-compose.yml` use `-` (hyphens)** (`mcp-rdkit`, `mcp-drfp`, `reaction-vectorizer`). The compose name and the Python module name deliberately diverge.
- Each service has its own `requirements.txt` (Python) or `package.json` (TypeScript). The root `pyproject.toml` is a workspace stub; it does NOT list service deps — the `make setup` target installs them via per-service requirements files.

## Row-Level Security — the rule

Every project-scoped query must run in a transaction with `app.current_user_entra_id` set. The DB layer ships three roles (defined in `db/init/12_security_hardening.sql`):

| Role | LOGIN | BYPASSRLS | Used for |
|---|---|---|---|
| `chemclaw` | yes | implicit (table owner) | DB init + migrations only — **never** for app traffic |
| `chemclaw_app` | yes | NO | All app traffic (agent-claw, paperclip). Subject to FORCE RLS. |
| `chemclaw_service` | yes | YES | Projectors, ingestion workers, the optimizer cron, `session_reanimator`. |

`FORCE ROW LEVEL SECURITY` is set on every project-scoped table, so even `chemclaw` (the owner) is RLS-enforced — there is no "owner shortcut."

Use the helper functions:

- **TypeScript agent**: `withUserContext(pool, userEntraId, async (client) => ...)` in `services/agent-claw/src/db/with-user-context.ts`. For globally-scoped catalog reads (prompt_registry, skill_library, mcp_tools), use `withSystemContext(pool, fn)` — same module — which sets the sentinel user `'__system__'` so RLS policies that gate on `current_setting('app.current_user_entra_id')` being non-empty pass without leaking into a real user's identity.
- **Local CLI testing**: `chemclaw chat "..."` (see `tools/cli/README.md`). The CLI sends `x-user-entra-id` from `$CHEMCLAW_USER` and agent-claw applies it to the per-request RLS context.
- **Projectors and system workers**: connect as `chemclaw_service` (BYPASSRLS) so they can read across all projects without setting a per-row user. The `session_reanimator` follows this pattern.

**Never bypass RLS by connecting as the DB owner from user-facing code.** If a query returns rows the user shouldn't see, the bug is a missing or wrong `SET LOCAL`, not a missing WHERE clause.

## Confidence model and bi-temporal canonical columns (PR-8)

`17_unified_confidence_and_temporal.sql` adds an additive (no readers broken) layer on top of the existing schema:

| Table | Score column | Tier column | Bi-temporal cols |
|---|---|---|---|
| `reactions` | `confidence_score NUMERIC(4,3)` (PR-8, backfilled from tier) | `confidence_tier TEXT` (5-value, original) | `valid_from`, `valid_to`, `invalidated` |
| `hypotheses` | `confidence NUMERIC(4,3)` (original) | `confidence_tier` GENERATED 3-value (original) | `valid_from`, `valid_to`, `refuted_at` |
| `artifacts` | `confidence_score NUMERIC(4,3)` (PR-8) | — | `valid_from`, `superseded_at` |

`skill_library` and `forged_tool_tests` now have `maturity TEXT NOT NULL DEFAULT 'EXPLORATORY' CHECK (maturity IN ('EXPLORATORY', 'WORKING', 'FOUNDATION'))`, consistent with the maturity tiers used by `hypotheses`, `artifacts`, and `document_chunks`.

PR-8 also added two indexes (`idx_user_project_access_user_project`, `idx_synthetic_steps_project`) to fix unindexed RLS EXISTS subqueries that were sequential-scanning on every authenticated query, and gave `skill_library` an explicit DELETE policy so users can remove their own skills.

Track which init files have been applied via the `schema_version` table populated by the `make db.init` loop — `SELECT * FROM schema_version ORDER BY filename`.

## Persistent agent sessions (autonomy upgrade)

ChemClaw's agent has Claude-Code-like autonomy primitives backed by three new tables (`db/init/13_agent_sessions.sql` + `14_agent_session_extensions.sql`):

| Table | Purpose |
|---|---|
| `agent_sessions` | Per-session scratchpad, awaiting_question, finish reason, message count, etag for optimistic concurrency, cross-turn token budget counters, auto-resume cap |
| `agent_todos` | Per-session checklist (the `manage_todos` tool's storage) |
| `agent_plans` | DB-backed plan storage (replaces the legacy in-memory 5-minute planStore for chained execution) |

The `/api/chat` endpoint accepts an optional `session_id` and emits a `session` SSE event for the client to round-trip. Two new builtins drive the experience:

- **`manage_todos`** (`tools/builtins/manage_todos.ts`) — the LLM creates a checklist at the start of any 3+ step task and ticks items off. Each call emits a `todo_update` SSE event so the user's UI renders live progress.
- **`ask_user`** (`tools/builtins/ask_user.ts`) — pauses the harness with a clarifying question. The harness emits `awaiting_user_input` SSE event, persists the question to `agent_sessions.awaiting_question` (redacted first), and ends the stream. Resume by POSTing `/api/chat` with the same `session_id` + a user message.

Chained execution: `POST /api/sessions/:id/plan/run` runs the harness in a loop bounded by `AGENT_PLAN_MAX_AUTO_TURNS` until the plan completes, max_steps is hit at the chain cap, the per-session token budget trips, or `ask_user` fires.

Auto-resume: `services/optimizer/session_reanimator/` polls every 5 min for sessions with stalled `in_progress` todos and POSTs `/api/sessions/:id/resume` (synthetic "Continue" turn). Capped per-session via `agent_sessions.auto_resume_cap` (default 10).

## Secrets and egress

- **All LLM calls route through LiteLLM** (`services/litellm/config.yaml`). Never import provider SDKs directly in application code; always go through `litellm`. The agent uses `@ai-sdk/openai-compatible` with `baseURL` pointing at LiteLLM's OpenAI-compatible endpoint — this is the single egress chokepoint.
- **Every prompt is redacted pre-egress** by the callback at `services/litellm_redactor/callback.py`. When adding new sensitive categories (new project-ID patterns, new compound-code formats), extend `services/litellm_redactor/redaction.py` and add a unit test in `tests/unit/test_redactor.py`.
- The regex patterns in the redactor are length-bounded by construction — if you add new patterns, bound every quantifier (no unbounded `.*`) to avoid catastrophic backtracking.
- **System prompts come from `prompt_registry`, not from hardcoded strings.** When adding a new agent mode, insert a new row (see `db/seed/02_prompt_registry.sql` for the canonical pattern) and reference it by name in code. The `PromptRegistry` cache TTL is 60s; call `invalidate()` in long-running processes if you hot-edit a prompt in the DB.
- **MCP service Bearer-token authentication (ADR 006 Layer 2)** — the agent
  mints HS256 JWTs via `services/agent-claw/src/security/mcp-tokens.ts`,
  attaches them to every `postJson` / `getJson` call via the AsyncLocalStorage
  request context, and MCP services verify via `services/mcp_tools/common/app.py`
  middleware. Set `MCP_AUTH_SIGNING_KEY` (≥32 chars; `openssl rand -hex 32`)
  in production. The reanimator daemon mints its own JWT (`agent:resume`
  scope) and posts to `/api/internal/sessions/:id/resume`, which trusts only
  the signed `claims.user` — no `x-user-entra-id` forgery surface. See
  `docs/runbooks/autonomy-upgrade.md` for the production rollout sequence.
- **MCP auth fail-closed in dev (Phase 7):** the default behaviour is to
  require a signed Bearer token on every MCP request. To run locally
  without minting tokens, explicitly set `MCP_AUTH_DEV_MODE=true` in your
  `.env` (the pytest conftest does this automatically for the test suite).
  There is NO automatic fallback — forgetting to set the dev-mode flag
  means MCP services reject your requests with 401, which is the correct
  production-safe behaviour. `MCP_AUTH_REQUIRED=true` is still honoured
  for backward-compat and overrides dev mode when both are set; routes
  no longer need to defensively check `if claims is None: deny` because
  the middleware raises 401 before the route runs.

## When adding a new MCP tool service

1. Create `services/mcp_tools/<snake_name>/` with `__init__.py`, `main.py`, `requirements.txt`, `Dockerfile`.
2. Use `create_app()` from `services.mcp_tools.common.app` — it gives you `/healthz`, `/readyz`, request-ID middleware, and `ValueError → 400` handling for free.
3. Validate every input via Pydantic; validate chemistry-specific inputs (e.g., SMILES) before doing any work. Raise `ValueError` with a specific reason on bad input.
4. Dockerfile runs as UID 1001 (OpenShift SCC requirement).
5. Add the service to `docker-compose.yml` with a `security_opt: [no-new-privileges:true]` and a healthcheck.

## When adding a new projector

1. Subclass `BaseProjector` (`services/projectors/common/base.py`).
2. Declare `name` (unique — becomes the ack key) and `interested_event_types` (tuple of strings).
3. Implement `async handle(...)`. The base class handles startup catch-up, LISTEN/NOTIFY, acking, signals, and restart safety.
4. Handlers **must be idempotent** — running twice on the same event must be safe. Use `ON CONFLICT DO NOTHING` on inserts, `WHERE ... IS NULL` guards on updates.
5. Failures do not ack, so retries happen on next NOTIFY. If a handler can't recover, log and move on — don't crash the projector.

## Files and artifacts that don't live in the repo

- The plan file at `~/.claude/plans/chemos-knowledge-intelligence-tranquil-marshmallow.md` — architectural spec.
- Two reference whitepapers in `documentation/` (tracked in git): the pharma autonomous-agents whitepaper and the NemoClaw / Paperclip / Hermes technical review. These informed every decision and are the canonical source for rationale.

## Status — Claw Code v1.0.0-claw (all phases complete)

All phases A through F.2 of the Claw Code harness redesign are complete.
The plan document is at `~/.claude/plans/go-through-the-three-vivid-sunset.md`.

- **Phase A** (greenfield harness skeleton): custom ~500-LOC while-loop harness, slash parser, YAML hooks, tool registry, `AGENTS.md`. Port 3101.
- **Phase B** (tool migration + skills + original-doc access): 12 tools ported; `mcp_doc_fetcher`; `fetch_original_document`; 4 skill packs; sub-agent spawner; plan-mode preview.
- **Phase C** (memory tiers + maturity + confidence): working-memory compactor; `contextual_chunker` projector; `skill_library` table; maturity tiers (`EXPLORATORY/WORKING/FOUNDATION`); 3-signal confidence ensemble.
- **Phase D** (PTC + Paperclip-lite + Langfuse + feedback): E2B PTC sandbox; `run_program`; Paperclip-lite sidecar; Langfuse OTel tracing; `/feedback` wired to DB; multi-model routing.
- **Phase D.5** (tool forging): `forge_tool`, `induce_forged_tool_from_trace`, `add_forged_tool_test`; `forged_tool_validation_runs` table; weak-from-strong transfer; scope promotion (private → project → org).
- **Phase E** (self-improvement): DSPy GEPA nightly optimizer; golden set + held-out promotion gate; skill promotion loop; shadow serving (`shadow_until` column); `/eval` slash verb.
- **Phase F.1** (chemistry MCPs): chemistry services on the `chemistry` profile: askcos (8007), aizynth (8008), chemprop (8009), xtb (8010), sirius (8012). The admetlab adapter has been removed from this build.
- **Phase F.2** (source-system MCPs): **two adapters wired**, replacing the deleted vendor-specific ones.
  - **`mcp_eln_local`** (port 8013, profile `testbed`) — local Postgres-backed mock ELN. Reads from the `mock_eln` schema seeded with ≥ 2000 deterministic experiments across 4 projects, 10 chemistry families, 10 OFAT campaigns. Entry shapes: 80% mixed (structured + freetext), 7% pure-structured, 8% pure-freetext, 5% extreme. Five agent-claw builtins including OFAT-aware `query_eln_canonical_reactions` that collapses 200-row OFAT campaigns into one canonical-reaction row with `ofat_count`. Plan + design: `docs/plans/eln-mock-and-logs-sciy.md`.
  - **`mcp_logs_sciy`** (port 8016, profile `sources`) — LOGS-by-SciY adapter (HPLC/NMR/MS analytical SDMS). Two backends: `fake-postgres` (default, reads `fake_logs` schema with ~3000 datasets cross-linked to `mock_eln.samples`) and `real` (stub; gated on tenant access). Three agent-claw builtins.
  - The `source-cache` post-tool hook + `kg_source_cache` projector pick both up automatically via the unchanged regex `/^(query|fetch)_(eln|lims|instrument)_/`.
  - `eln_json_importer` retired from live path; preserved as `services/ingestion/eln_json_importer.legacy/` for one-shot bulk migrations from a JSON dump.
  - Helm chart: `infra/helm/` with profile flags (chemistry/sources/optimizer/observability/testbed).
  - `services/agent/` deleted; Streamlit `AGENT_BASE_URL` defaults to port 3101.
  - `docs/adr/004-harness-engineering.md`, `docs/adr/005-data-layer-revision.md`, `docs/runbooks/harness-rollback.md`.
  - Tagged `v1.0.0-claw`.

## Test counts (current branch)

```
cd services/agent-claw && npm test          →  772 passed (102 files)
cd services/agent-claw && npx tsc --noEmit  →  ok
cd services/paperclip && npm test           →  17 passed
.venv/bin/pytest services/mcp_tools/common/tests/ -q   →  33 passed
npm audit (root)                            →  0 vulnerabilities
```

The integration trio (`etag-conflict`, `chained-execution`,
`reanimator-roundtrip`) requires Docker — the testcontainer harness in
`services/agent-claw/tests/helpers/postgres-container.ts` self-skips
when Docker is unavailable. The full suite above was run with Docker
present.

## Harness Primitives

The agent harness (`services/agent-claw/`) has 16 lifecycle hook points. **`loadHooks(lifecycle, deps)`** in `services/agent-claw/src/core/hook-loader.ts` is the **single registration path** on the production startup path; YAML files in `hooks/` are the source of truth for which hooks run, and every hook name in YAML must have a matching entry in `BUILTIN_REGISTRARS`. The orphan `buildDefaultLifecycle()` factory was deleted in Phase 1B — all four harness call paths (`/api/chat`, `/api/chat/plan/approve`, `/api/sessions/:id/plan/run`, `/api/sessions/:id/resume`) plus sub-agents read the single global lifecycle that `loadHooks` populates at boot.

| Hook point | When it fires | Current hooks |
|---|---|---|
| `session_start` | Once at session creation | `session-events` (telemetry) |
| `session_end` | On session finalisation | (declared; no built-ins yet) |
| `user_prompt_submit` | Before a user turn enters the loop | (declared; no built-ins yet) |
| `pre_turn` | Before LLM call; after slash parsing | `init-scratch`, `apply-skills` |
| `pre_tool` | Before a tool executes | `budget-guard`, `foundation-citation-guard` |
| `post_tool` | After a tool returns | `anti-fabrication`, `tag-maturity`, `source-cache` |
| `post_tool_failure` | After a tool throws | (declared; no built-ins yet) |
| `post_tool_batch` | After a parallel readonly batch resolves | (declared; no built-ins yet) |
| `permission_request` | When the resolver in `core/permissions/resolver.ts` needs a decision (Phase 6) | `permission` (no-op default — operators replace with custom policy). NOTE: the resolver is wired in `core/step.ts` but only fires when a route passes a `permissions` option to `runHarness`; no production route does today, so the chain runs only in unit / parity tests. |
| `subagent_start` | Before a sub-agent runHarness call | (declared; no built-ins yet) |
| `subagent_stop` | After a sub-agent returns | (declared; no built-ins yet) |
| `task_created` | When `manage_todos` adds an item | (declared; no built-ins yet) |
| `task_completed` | When a todo flips to `completed` | (declared; no built-ins yet) |
| `pre_compact` | When context > 60% of budget | `compact-window` (invokes Haiku compactor) |
| `post_compact` | After compaction returns | (declared; no built-ins yet) |
| `post_turn` | After the loop exits; before the SSE stream closes (when streaming) — fires inside `runHarness`'s finally so scratchpad / redaction work runs before the route's reply ends | `redact-secrets` (defense-in-depth output scrub) |

**Lifecycle is a process-wide singleton** in `services/agent-claw/src/core/runtime.ts`. At server startup `index.ts` calls `loadHooks(lifecycle, deps)` from `core/hook-loader.ts`, which iterates `hooks/*.yaml` and registers each entry from `BUILTIN_REGISTRARS` into the singleton. All harness call paths (`/api/chat`, `/api/chat/plan/approve`, `/api/sessions/:id/plan/run`, `/api/sessions/:id/resume`, `/api/deep_research`) and sub-agents import the same singleton, so a hook addition picks up everywhere automatically. `core/session-state.ts` exports `hydrateScratchpad` and `persistTurnState` — the rehydrate-from-session and end-of-turn save patterns shared across routes.

Hook callbacks follow the Claude Agent SDK shape — `(input, toolUseID, { signal: AbortSignal }) => Promise<HookJSONOutput>` — and aggregate decisions via `deny > defer > ask > allow`. Each dispatch gets a per-call AbortController with a 60 s default timeout. See ADRs [007 (hook system rebuild)](docs/adr/007-hook-system-rebuild.md), [008 (collapsed ReAct loop)](docs/adr/008-collapsed-react-loop.md), [009 (permission and decision contract)](docs/adr/009-permission-and-decision-contract.md), [010 (deferred phases)](docs/adr/010-deferred-phases.md), and the [`docs/PARITY.md`](docs/PARITY.md) tracker for the full v1.2.0-harness story.

Hook files: `hooks/*.yaml` (definition) + `services/agent-claw/src/core/hooks/*.ts` (implementation).

To add a hook:
1. Add the implementation in `services/agent-claw/src/core/hooks/<name>.ts` (export a `register<Name>Hook(lifecycle, ...deps)` function).
2. Add the YAML definition in `hooks/<name>.yaml` (declares the lifecycle phase).
3. Register the registrar in the `BUILTIN_REGISTRARS` map in `core/hook-loader.ts`.
4. Write a vitest test under `services/agent-claw/tests/unit/`.
5. Bump `MIN_EXPECTED_HOOKS` in `index.ts` so the startup assertion catches a future regression where the new hook silently fails to load.

The loader returns a `HookLoadResult.skipped` list at boot, so a YAML without a registrar (or vice versa) surfaces immediately.

To replay a projector: `DELETE FROM projection_acks WHERE projector_name='<name>';` then restart the container.
