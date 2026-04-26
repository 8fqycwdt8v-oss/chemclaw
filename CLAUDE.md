# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
make run.agent                   # http://localhost:3100
make run.frontend                # http://localhost:8501
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
npm run test --workspace services/agent -- tests/unit/some.test.ts
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
| `chemclaw_app` | yes | NO | All app traffic (agent-claw, frontend, paperclip). Subject to FORCE RLS. |
| `chemclaw_service` | yes | YES | Projectors, ingestion workers, the optimizer cron, `session_reanimator`. |

`FORCE ROW LEVEL SECURITY` is set on every project-scoped table, so even `chemclaw` (the owner) is RLS-enforced — there is no "owner shortcut."

Use the helper functions:

- **TypeScript agent**: `withUserContext(pool, userEntraId, async (client) => ...)` in `services/agent-claw/src/db/with-user-context.ts`. For globally-scoped catalog reads (prompt_registry, skill_library, mcp_tools), use `withSystemContext(pool, fn)` — same module — which sets the sentinel user `'__system__'` so RLS policies that gate on `current_setting('app.current_user_entra_id')` being non-empty pass without leaking into a real user's identity.
- **Python Streamlit**: `connect(user_entra_id)` context manager in `services/frontend/db.py`.
- **Projectors and system workers**: connect as `chemclaw_service` (BYPASSRLS) so they can read across all projects without setting a per-row user. The `session_reanimator` follows this pattern.

**Never bypass RLS by connecting as the DB owner from user-facing code.** If a query returns rows the user shouldn't see, the bug is a missing or wrong `SET LOCAL`, not a missing WHERE clause.

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
- **MCP service Bearer-token authentication (ADR 006 Layer 2)** is implemented — the agent can mint HS256 JWTs via `services/agent-claw/src/security/mcp-tokens.ts` and MCP services verify via `services/mcp_tools/common/auth.py`. **Currently it is not wired end-to-end** (the agent doesn't yet call `signMcpToken` on outbound MCP requests, and `create_app()` doesn't yet add `Depends(require_mcp_token)` as a dependency). Wiring is tracked as a follow-up; setting `MCP_AUTH_REQUIRED=true` today would lock the cluster out. See `docs/adr/006-sandbox-isolation.md` and `docs/runbooks/autonomy-upgrade.md` for the rollout plan.

## Secrets and egress

- **All LLM calls route through LiteLLM** (`services/litellm/config.yaml`). Never import provider SDKs directly in application code; always go through `litellm`. The agent uses `@ai-sdk/openai` with `baseURL` pointing at LiteLLM's OpenAI-compatible endpoint — this is the single egress chokepoint.
- **Every prompt is redacted pre-egress** by the callback at `services/litellm_redactor/callback.py`. When adding new sensitive categories (new project-ID patterns, new compound-code formats), extend `services/litellm_redactor/redaction.py` and add a unit test in `tests/unit/test_redactor.py`.
- The regex patterns in the redactor are length-bounded by construction — if you add new patterns, bound every quantifier (no unbounded `.*`) to avoid catastrophic backtracking.
- **System prompts come from `prompt_registry`, not from hardcoded strings.** When adding a new agent mode, insert a new row (see `db/seed/02_prompt_registry.sql` for the canonical pattern) and reference it by name in code. The `PromptRegistry` cache TTL is 60s; call `invalidate()` in long-running processes if you hot-edit a prompt in the DB.

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
- **Phase F.1** (chemistry MCPs): 6 new chemistry services: askcos (8007), aizynth (8008), chemprop (8009), xtb (8010), admetlab (8011), sirius (8012). 6 skill packs.
- **Phase F.2** (source-system MCPs + retire legacy): **complete**.
  - `mcp_eln_benchling` (8013) — Benchling ELN adapter; `GET /experiments/{id}` + `POST /query_runs`.
  - `mcp_lims_starlims` (8014) — STARLIMS LIMS adapter; `GET /test_results/{id}` + `POST /query_results`.
  - `mcp_instrument_waters` (8015) — Waters Empower HPLC adapter; `GET /run/{id}` + `POST /search_runs`. Template in `mcp_instrument_template/README.md`.
  - 6 agent-claw builtins: `query/fetch_eln_*`, `query/fetch_lims_*`, `query/fetch_instrument_*`.
  - `source-cache` post-tool hook + `kg_source_cache` projector — source facts → `:Fact` nodes with `(source_system_id, fetched_at, valid_until)` provenance.
  - `eln_json_importer` retired from live path; preserved as `services/ingestion/eln_json_importer.legacy/`.
  - Helm chart: `infra/helm/` with profile flags (chemistry/sources/optimizer/observability); 26 Deployments in prod config.
  - `services/agent/` deleted; Streamlit `AGENT_BASE_URL` defaults to port 3101.
  - `docs/adr/004-harness-engineering.md`, `docs/adr/005-data-layer-revision.md`, `docs/runbooks/harness-rollback.md`.
  - Tagged `v1.0.0-claw`.

## Test counts (current branch)

```
cd services/agent-claw && npm test          →  657 passed
cd services/agent-claw && npx tsc --noEmit  →  ok
cd services/paperclip && npm test           →  17 passed
python3 -m pytest tests/unit/test_redactor.py \
  services/mcp_tools/mcp_eln_benchling/tests/ \
  services/mcp_tools/mcp_lims_starlims/tests/ \
  services/mcp_tools/mcp_instrument_waters/tests/ \
  services/mcp_tools/common/tests/ \
  services/projectors/kg_source_cache/tests/   →  49 passed
npm audit (root)                            →  0 vulnerabilities
```

## Harness Primitives

The agent harness (`services/agent-claw/`) has five lifecycle hook points:

| Hook point | When it fires | Current hooks |
|---|---|---|
| `pre_turn` | Before LLM call; after slash parsing | `init-scratch`, `apply-skills`, stale-fact check |
| `pre_tool` | Before a tool executes | `anti-fabrication`, `budget-guard`, `foundation-citation-guard` |
| `post_tool` | After a tool returns | `tag-maturity`, `source-cache`, `compact-window`, `todo_update` SSE emit |
| `pre_compact` | When context > 60% of budget | `compact-window` (invokes Haiku compactor) |
| `post_turn` | After SSE stream closes | `redact-secrets` (defense-in-depth output scrub) |

**Default lifecycle is built via `buildDefaultLifecycle()`** in `services/agent-claw/src/core/harness-builders.ts`. All three harness call paths (`/api/chat`, `/api/chat/plan/approve`, `/api/sessions/:id/plan/run`, `/api/sessions/:id/resume`) use the same factory so a hook addition picks up everywhere automatically. Same module exports `hydrateScratchpad` and `persistTurnState` — the rehydrate-from-session and end-of-turn save patterns shared across routes.

Hook files: `hooks/*.yaml` (definition) + `services/agent-claw/src/core/hooks/*.ts` (implementation).

To add a hook: create both files; register in `lifecycle.ts`; write a vitest test. No harness changes needed.

To replay a projector: `DELETE FROM projection_acks WHERE projector_name='<name>';` then restart the container.
