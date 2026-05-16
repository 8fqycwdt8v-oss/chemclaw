# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repo.

## Hard requirements — every change, every session

These are non-negotiable. They override convenience.

1. **Commit everything before the session ends.** Uncommitted edits don't survive parallel sessions, terminal restarts, or the parent checkout's branch flipping. No work-in-progress left loose.
2. **Merge everything back to `main` via a reviewed PR. No direct commits to `main`.** Every branch ends in: `gh pr create` → wait for CI green (poll via `Monitor` / `gh pr checks`; fix real failures, don't bypass) → **the agent runs `/review` on its own PR and iterates via fixup commits to the same branch until the review comes back clean** → `gh pr merge <N> --merge` → delete remote branch (`git push origin --delete <branch>`), local branch (`git branch -D`), and any worktree if one was used (`git worktree remove`). The user does NOT review PRs manually and does NOT trigger `/review`. An open PR — or a PR with unaddressed review findings — is unfinished work. The PR description is the audit trail; write a real one.
3. **Define success criteria up front; verify before claiming done.** State what "done" looks like (specific command output, test count, observable behavior). Run the verification yourself; don't hand back partial work labeled green.

CI flakes blocking merge: skip-list / xfail and note in `BACKLOG.md` rather than waiting on a human. Stacked PRs: merge each as it goes green, retarget the next via `gh pr edit --base main` after its parent merges.

## Strongly recommended (skip only with a reason)

- **Single worktree for multi-agent / multi-step sessions.** Do NOT spin up `git worktree add ../chemclaw-<task>` per agent or per phase. Parallel worktrees off `main` produce concurrent diffs that collide at merge time. Stay in the existing checkout, branch sequentially off `main`, finish-and-merge each branch before starting the next, and dispatch sub-agents inside the same working tree. Worktrees are reserved for the rare case of needing a clean tree to debug a separate bug while the current branch is mid-flight — not the default.
- **Plan before code** for multi-step work — `superpowers:brainstorming` → `superpowers:writing-plans` → `superpowers:executing-plans` (or `superpowers:subagent-driven-development`).
- **`superpowers:finishing-a-development-branch`** as a checklist for the merge-and-cleanup loop in rule 2.

## General rules

1. **Surface tradeoffs; don't paper over ambiguity.** If two paths exist, name them and the cost of each before picking.
2. **Minimum code that solves the problem.** No speculative abstractions, no flags for hypothetical needs, no error handling for cases that can't happen. Three similar lines beat a premature abstraction.
3. **Touch only what you must. Clean up only your mess.** Investigate unfamiliar files / branches / state before deleting or overwriting — they belong to someone else.
4. **Log deferred work to `BACKLOG.md`.** One bullet per item, prefixed by area, terse and scannable: `- [agent-claw/skills] expose MAX_ACTIVE_SKILLS via config_settings`. Append-only, no headers, no dating. Create the file if missing.

## What ChemClaw is

Autonomous knowledge-intelligence agent for pharmaceutical chemical & analytical development. Central artifact: a **living bi-temporal knowledge graph** of compounds / reactions / experiments / conditions / documents with confidence-scored edges and explicit contradiction handling. Vector search is complementary, not a replacement. Designed to act **proactively** (new data triggers autonomous investigation + outbound chat notifications) and to use scientific tools autonomously (RDKit, DFT, GFN2-xTB, TabPFN, etc.).

Authoritative design doc: `~/.claude/plans/chemos-knowledge-intelligence-tranquil-marshmallow.md`. Architecture summary: `docs/adr/001-architecture.md`.

## A-on-C event-sourced ingestion (the load-bearing pattern)

Ingestion writes **canonical records to Postgres first**, which emits events via `NOTIFY ingestion_events`. **Projectors** (stateless Python workers in `services/projectors/*`) subscribe via `LISTEN` and derive views: KG nodes/edges in Neo4j (via Graphiti), vector collections in pgvector, reaction DRFP vectors, etc. The agent reads those derived views at query time.

To add a new data type:
1. Canonical table in `db/init/01_schema.sql`.
2. Ingesting worker `INSERT`s the row and an `ingestion_events` row with a typed `event_type` (the `notify_ingestion_event` trigger fires `NOTIFY` automatically).
3. Subclass `BaseProjector` (`services/projectors/common/base.py`), declaring the `event_type`(s) it handles. Acks via `projection_acks` make projectors safely replayable.

**Never update a derived view without an event.** Full KG / vector rebuild = `DELETE FROM projection_acks WHERE projector_name=X` and the projector re-derives from the event log.

## Control flow

- **Agent reasoning loop**: pure ReAct, no DAG. Lives in `services/agent-claw/` (TypeScript, custom ~500-LOC harness; Mastra dropped in Phase A). Port 3101.
- **Tools** (retrieval, KG ops, scientific compute, source systems): MCP/REST endpoints. Tools are Python; TypeScript builtins wrap them via typed `McpClient`.
- **Plumbing** (ingestion, projectors, correction propagation): deterministic, rule-based. Never put LLM reasoning in these paths.
- **Skills, DR, cross-project learning** are skill packs the agent chooses to invoke — see `skills/`.

## Stack

- **Python for scientific tools**: RDKit, Marker, ChemDataExtractor, DRFP, TabPFN, nmrglue, pyopenms have no TypeScript equivalents.
- **Node.js/TypeScript for orchestration** (agent-claw, Paperclip-lite): better async + tool-schema typing.
- **MCP is the cross-language boundary** — tools never import each other; everything is JSON over HTTP.
- **Paperclip-lite** (~500 LOC): heartbeat + budget + per-user concurrency. No GxP features.
- **Graphiti + Neo4j Community** for the bi-temporal KG. GPL-3.0 server-side only, no binary redistribution.
- **pgvector + pgvectorscale on the app Postgres** — one DB for state + vectors.

## Key commands

```bash
# Setup
cp .env.example .env && make setup        # idempotent
make up                                   # Postgres + Neo4j
make up.full                              # all services
make ps / make down / make nuke           # nuke drops volumes

# Observability stack — Loki:3100 + Grafana:3001 + Langfuse:3000 (bound to 127.0.0.1; LOKI_BIND/GRAFANA_BIND to expose)
docker compose --profile observability up -d
./scripts/check-logs-pipeline.sh

# Data
make db.psql / db.init / db.seed / import.sample

# Run individual services
make run.agent                # :3101
chemclaw chat "..."           # CLI; tools/cli/README.md. Streamlit lives in a separate repo now.
make run.mcp-rdkit            # :8001
make run.mcp-drfp             # :8002
make run.reaction-vectorizer  # LISTEN/NOTIFY projector

# Quality
make lint / format / typecheck / test
.venv/bin/pytest tests/unit/test_redactor.py -v
.venv/bin/pytest tests/unit/test_redactor.py::test_redaction_is_deterministic -v
npm run test --workspace services/agent-claw -- tests/unit/some.test.ts

# End-to-end smoke
./scripts/smoke.sh
```

## Directory conventions

- Python packages use `_` (hyphens are illegal in Python identifiers): `services/mcp_tools/`, `services/mcp_rdkit/`.
- Container/service names in `docker-compose.yml` use `-`: `mcp-rdkit`, `mcp-drfp`. Compose name and Python module name diverge intentionally.
- Each service has its own `requirements.txt` / `package.json`. Root `pyproject.toml` is a workspace stub; `make setup` installs per-service.

## Row-Level Security

Every project-scoped query runs in a transaction with `app.current_user_entra_id` set. Three DB roles (`db/init/12_security_hardening.sql`):

| Role | LOGIN | BYPASSRLS | Used for |
|---|---|---|---|
| `chemclaw` | yes | implicit (table owner) | DB init / migrations only — **never** app traffic |
| `chemclaw_app` | yes | NO | All app traffic. Subject to FORCE RLS. |
| `chemclaw_service` | yes | YES | Projectors, ingestion workers, optimizer cron, `session_reanimator`. |

`FORCE ROW LEVEL SECURITY` is set on every project-scoped table — the table owner is RLS-enforced too. No "owner shortcut."

- **TypeScript agent**: `withUserContext(pool, userEntraId, fn)` from `services/agent-claw/src/db/with-user-context.ts`. Globally-scoped catalog reads (prompt_registry, skill_library, mcp_tools): `withSystemContext(pool, fn)` — sets sentinel `'__system__'` so non-empty-user RLS gates pass without leaking a real identity.
- **Local CLI**: `chemclaw chat "..."` sends `x-user-entra-id` from `$CHEMCLAW_USER`.
- **Projectors / system workers**: connect as `chemclaw_service` (BYPASSRLS).

**Never bypass RLS by connecting as the owner from user-facing code.** If a query returns rows the user shouldn't see, the bug is a missing/wrong `SET LOCAL`, not a missing WHERE.

## Confidence + bi-temporal columns (PR-8)

`17_unified_confidence_and_temporal.sql` adds an additive layer:

| Table | Score | Tier | Bi-temporal |
|---|---|---|---|
| `reactions` | `confidence_score NUMERIC(4,3)` (PR-8, backfilled) | `confidence_tier TEXT` (5-value) | `valid_from`, `valid_to`, `invalidated` |
| `hypotheses` | `confidence NUMERIC(4,3)` | `confidence_tier` GENERATED 3-value | `valid_from`, `valid_to`, `refuted_at` |
| `artifacts` | `confidence_score NUMERIC(4,3)` (PR-8) | — | `valid_from`, `superseded_at` |

`skill_library` and `forged_tool_tests` carry `maturity TEXT NOT NULL DEFAULT 'EXPLORATORY' CHECK IN ('EXPLORATORY','WORKING','FOUNDATION')`, matching `hypotheses` / `artifacts` / `document_chunks`.

PR-8 also added `idx_user_project_access_user_project`, `idx_synthetic_steps_project` (RLS EXISTS subqueries were sequential-scanning) and an explicit `skill_library` DELETE policy.

Track applied init files: `SELECT * FROM schema_version ORDER BY filename` (populated by `make db.init`).

## Persistent agent sessions

Three tables (`db/init/13_agent_sessions.sql` + `14_agent_session_extensions.sql`):

| Table | Purpose |
|---|---|
| `agent_sessions` | Scratchpad, awaiting_question, finish reason, message count, etag, cross-turn token budget, auto-resume cap |
| `agent_todos` | `manage_todos` checklist storage |
| `agent_plans` | DB-backed plans (replaced 5-min in-memory `planStore`) |

`/api/chat` accepts `session_id` and emits a `session` SSE event. Two driving builtins:

- **`manage_todos`** (`tools/builtins/manage_todos.ts`) — checklist for any 3+ step task; emits `todo_update` SSE for live UI.
- **`ask_user`** (`tools/builtins/ask_user.ts`) — pauses the harness with a clarifying question; persists the redacted question to `agent_sessions.awaiting_question`; ends the stream. Resume: POST `/api/chat` with the same `session_id` + a user message.

Chained execution: `POST /api/sessions/:id/plan/run` runs the harness in a loop bounded by `AGENT_PLAN_MAX_AUTO_TURNS` until the plan completes, max_steps, the per-session token budget trips, or `ask_user` fires.

Auto-resume: `services/optimizer/session_reanimator/` polls every 5 min for stalled `in_progress` todos and POSTs `/api/sessions/:id/resume`. Capped per-session via `agent_sessions.auto_resume_cap` (default 10).

## Required patterns for new code

Every new feature MUST consume the existing registries / loggers. Hardcoded constants, scattered `process.env.X === 'true'` gates, and `console.log` calls don't pass review.

### Runtime config (`config_settings`)

Tunable knobs live in `config_settings` (`db/init/19_config_settings.sql`). Resolution: **user → project → org → global**, first hit wins. 60 s cache; admin mutations bust it.

- **TypeScript** — `getConfigRegistry()` from `services/agent-claw/src/config/registry.ts`:
  ```ts
  const cap = await getConfigRegistry().getNumber("agent.max_active_skills", { user, project, org }, 8);
  ```
  Singleton wired in `bootstrap/dependencies.ts` — never construct another in a route.
- **Python** — `from services.common.config_registry import ConfigRegistry, ConfigContext`:
  ```py
  reg = ConfigRegistry(dsn=os.environ["POSTGRES_DSN"])
  rate = reg.get_float("optimizer.promotion_success_rate", default=0.55)
  ```
  Same TTL; thread-safe; falls back to default on DB outage.
- Add rows via `PATCH /api/admin/config/:scope/:scope_id?key=K` (admin-gated; audited). Direct SQL is the escape hatch.

When a constant is born hardcoded, file a follow-up to migrate it.

### Feature flags

`feature_flags` (`db/init/22_feature_flags.sql`) is the source of truth — env-var gates are bootstrap fallbacks only.

```ts
import { isFeatureEnabled } from "../config/flags.js";
if (await isFeatureEnabled("agent.confidence_cross_model", { user, project, org })) { ... }
```

New flag: `POST /api/admin/feature-flags/:key` with a real `description`. Naming: lowercase, dotted (`mock_eln.enabled`). Env-var fallback is auto-derived (`mock_eln.enabled` → `MOCK_ELN_ENABLED`).

### Permission policies

`permission_policies` + the `permission` hook is the only allowlist/denylist surface. `POST /api/admin/permission-policies` (`scope`, `scope_id`, `decision`, `tool_pattern`, optional `argument_pattern`). Aggregator: **deny > ask > allow**; `tool_pattern` supports trailing wildcards.

Routes that run user-driven tool calls MUST pass `{ permissions: { permissionMode: "enforce" } }` to `runHarness`. `/api/chat` is wired today; new routes follow.

### Redaction patterns

Hardcoded patterns in `services/litellm_redactor/redaction.py` are the SAFETY BASELINE — always run. The `redaction_patterns` table (`db/init/20_redaction_patterns.sql`) is merged in via `dynamic_patterns.py:get_loader()` for tenant-specific variations. Two safety rails: DB CHECK on `length ≤ 200` AND `is_pattern_safe()` rejecting unbounded `.*` / `.+` / `\S+`.

A fundamentally NEW category extends the hardcoded baseline + `tests/unit/test_redactor.py`; the table is for tenant variation, not new categories.

### Admin RBAC + audit

Every `/api/admin/*` mutation goes through `services/agent-claw/src/middleware/require-admin.ts` (`isAdmin` / `requireAdmin` / `guardAdmin`) and writes via `appendAudit` (`routes/admin/audit-log.ts`). Three roles in `admin_roles`: `global_admin`, `org_admin <scope_id>`, `project_admin <scope_id>`. RLS policies call `current_user_is_admin()` (SECURITY DEFINER, in `db/init/18_admin_roles_and_audit.sql`) so they don't recurse on `admin_roles`.

New admin endpoint:
1. Mount in `services/agent-claw/src/routes/admin/`; register in `routes/admin/index.ts`.
2. `guardAdmin` (or `requireAdmin`) at the top.
3. `appendAudit` on every state-mutating branch with a meaningful `action` (`<resource>.<verb>`) and before/after.
4. If the resource has a singleton cache (config, flags, permission policies, skill loader), call `.invalidate()` after the write.

`AGENT_ADMIN_USERS` is a bootstrap fallback for `global_admin` only.

### Hook YAML extensions

`hooks/*.yaml` accepts beyond `name` / `lifecycle` / `enabled` / `script` / `definition`:
- `order: <number>` — ascending sort within a phase (default 100; filename tiebreaker).
- `timeout_ms: <number>` — overrides 60 s default (script hooks only).
- `condition: { setting_key, env_var, default }` — gate registration. Resolution: setting → env → default.

Reordering / conditioning / tuning happens in YAML; ADDING a new hook still requires a `BUILTIN_REGISTRARS` entry + bumping `MIN_EXPECTED_HOOKS`.

### Logging

Never `console.log` / `print` in service code. Both layers structure-log; never concatenate user input into the format string — pass values as fields/args. Output ships via Promtail → Loki → Grafana.

- **TypeScript** — `getLogger` from `services/agent-claw/src/observability/logger.ts`:
  ```ts
  import { getLogger } from "../observability/logger.js";
  const log = getLogger("ToolRegistry");
  log.warn({ toolId, reason }, "tool disabled");
  ```
  Pino; level from `AGENT_LOG_LEVEL`; path-redacts `authorization` / `cookie` / `detail` / `*.password` / `*.token`. The custom `err` / `error` / `err_msg` serializers in `services/agent-claw/src/observability/logger.ts` route `err.message`, `err.stack`, and the cause chain through `scrub()` (the same length-bounded regex pipeline as the egress redactor) so SMILES / compound codes / NCE-IDs embedded in driver error strings are masked before formatting. Cause-chain walk capped at depth 5 with a WeakSet cycle guard.
- **Python** — `configure_logging` from `services.mcp_tools.common.logging`:
  ```py
  from services.mcp_tools.common.logging import configure_logging
  configure_logging(level=os.environ.get("LOG_LEVEL", "INFO"))
  log = logging.getLogger(__name__)
  log.warning("tool %s disabled: %s", tool_id, reason)
  ```
  JSON formatter; quiets `uvicorn.access` and `httpx`.

`LOG_USER_SALT` MUST be set outside dev — loggers throw on startup without it. Default salt is public; without a real per-deployment salt the user hash is rainbow-table-reversible.

DB-side audit: `error_events` (via `record_error_event`, `chemclaw_app` / `chemclaw_service` only) and `audit_row_change` triggers — both wrapped in `EXCEPTION WHEN OTHERS` so a missing partition can't take down audited writes (failures forward to `error_events`). Don't bypass these on new audited tables.

### Runbooks

- `docs/runbooks/add-tenant.md`
- `docs/runbooks/agent-filesystem-tools.md`
- `docs/runbooks/autonomy-upgrade.md`
- `docs/runbooks/backup-and-restore.md`
- `docs/runbooks/change-llm-provider.md`
- `docs/runbooks/chromatography-method-optimization.md`
- `docs/runbooks/disable-tool.md`
- `docs/runbooks/harness-rollback.md`
- `docs/runbooks/knowledge-wiki-curation.md`
- `docs/runbooks/local-dev.md`
- `docs/runbooks/monty-enable-and-rollback.md`
- `docs/runbooks/post-v1.0.0-hardening.md`
- `docs/runbooks/redaction-pattern-management.md`
- `docs/runbooks/rotate-mcp-auth-key.md`
- `docs/runbooks/synthesis-campaign-lifecycle.md`

Read the relevant runbook BEFORE filing a feature that asks an admin to do anything new.

## Secrets and egress

- **All LLM calls route through LiteLLM** (`services/litellm/config.yaml`). Never import provider SDKs directly — the agent uses `@ai-sdk/openai-compatible` against LiteLLM's OpenAI-compatible endpoint. Single egress chokepoint.
- **Every prompt is redacted pre-egress** by `services/litellm_redactor/callback.py`. New sensitive categories: extend `redaction.py` + add a unit test in `tests/unit/test_redactor.py`. Tenant-specific variations: `redaction_patterns` table.
- Bound every regex quantifier (no unbounded `.*`) — catastrophic-backtracking risk. The DB-backed loader's `is_pattern_safe()` enforces the same on tenant patterns.
- **System prompts come from `prompt_registry`**, not hardcoded strings. New mode = new row (see `db/seed/02_prompt_registry.sql`). `PromptRegistry` cache TTL is 60 s; call `invalidate()` if you hot-edit in long-running processes.
- **MCP Bearer-token auth (ADR 006 Layer 2)**: agent mints HS256 JWTs via `services/agent-claw/src/security/mcp-tokens.ts`, attaches them to every `postJson` / `getJson` via AsyncLocalStorage; MCP services verify via `services/mcp_tools/common/app.py` middleware. Set `MCP_AUTH_SIGNING_KEY` (≥32 chars; `openssl rand -hex 32`) in production. The reanimator daemon mints its own JWT (`agent:resume` scope) and posts to `/api/internal/sessions/:id/resume`, which trusts only the signed `claims.user` (no `x-user-entra-id` forgery surface). See `docs/runbooks/autonomy-upgrade.md`.
- **MCP fail-closed in dev (Phase 7)**: default is to require a Bearer token. Local dev without minting tokens = set `MCP_AUTH_DEV_MODE=true` in `.env` (pytest conftest sets this for the test suite). No automatic fallback. `MCP_AUTH_REQUIRED=true` is honoured for back-compat and overrides dev mode when both are set.

## Adding a new MCP tool service

1. `services/mcp_tools/<snake_name>/` with `__init__.py`, `main.py`, `requirements.txt`, `Dockerfile`.
2. Use `create_app()` from `services.mcp_tools.common.app` — gives `/healthz`, `/readyz`, request-ID middleware, `ValueError → 400`.
3. Validate every input via Pydantic; validate chemistry-specific inputs (e.g., SMILES) before doing work. Raise `ValueError` with a specific reason.
4. Dockerfile runs as UID 1001 (OpenShift SCC).
5. Add to `docker-compose.yml` with `security_opt: [no-new-privileges:true]` and a healthcheck.

## Adding a new projector

1. Subclass `BaseProjector` (`services/projectors/common/base.py`).
2. Declare `name` (unique — becomes the ack key) and `interested_event_types`.
3. Implement `async handle(...)`. Base class handles startup catch-up, LISTEN/NOTIFY, acking, signals, restart safety.
4. Handlers **must be idempotent** — `ON CONFLICT DO NOTHING`, `WHERE … IS NULL` guards.
5. Failures don't ack → retry on next NOTIFY. Don't crash the projector; log and move on.

To replay: `DELETE FROM projection_acks WHERE projector_name='<name>'` and restart the container.

**Custom NOTIFY channels (DR-06).** Three projectors (`compound_classifier`, `compound_fingerprinter`, `qm_kg`) bypass the default `ingestion_events` drive: they LISTEN on a custom channel where the payload is a domain key (e.g., inchikey, qm_jobs.id) rather than an ingestion_events row id. The bypass is via overriding `_connect_and_run` and leaving `interested_event_types = ()` so the base `_listen_loop` is skipped entirely. If you need this pattern, EITHER set `interested_event_types` and inherit the base behaviour, OR override `_connect_and_run` AND give the class a docstring that names the channel + payload semantics explicitly. No silent divergence.

**Direct-driver projectors (review 2026-05-10 §1.3).** `kg_hypotheses`, `kg_documents`, and `qm_kg` write to Neo4j directly rather than going through `mcp-kg`'s REST surface (which today only models `:Fact` nodes). They share `services/projectors/common/neo4j_client.py` (`Neo4jClient` async + `SyncNeo4jClient` sync variants + `SYSTEM_GROUP_ID` sentinel matching mcp-kg's server-side default). New direct-driver projectors should use this helper rather than constructing their own driver. `kg_experiments` and `kg_source_cache` continue to go through `mcp-kg` REST.

## Forging tools (best-effort hot-register contract)

`forge_tool` (`services/agent-claw/src/tools/builtins/forge_tool.ts`) persists a forged tool through `withUserContext` (`tools`, `forged_tool_tests`, optional `skill_library` row), then calls `registry.hotRegisterByName(pool, name)` so the tool is callable in the same chained turn that forged it. The hot-register runs **OUTSIDE** the persistence transaction by design:

- **Persistence is the source of truth.** A hot-register failure logs `forge_tool_hot_register_failed` / `forge_tool_hot_register_skipped` and returns — it does NOT unwind the persisted rows. The tool will load on the next agent restart via the normal registry boot scan.
- **Don't move the hot-register inside the transaction.** A txn-scoped hot-register would (a) hold the DB row locks for the duration of code-load / sandbox-validation and (b) leak a registered-but-uncommitted tool if the txn rolls back later.
- **`_sandboxClient` is required for forged-source rows.** A registry without a sandbox client can't validate forged code on hot-load; the call returns `false` (logged as `*_skipped`). Operators wiring a new agent process MUST call `registry.setSandboxClient(...)` before serving traffic, or every forged tool will be "available after restart" perpetually.
- **Reading from forged-tool tables.** Treat `tools` + `skill_library` as authoritative; the in-memory registry is a cache that catches up on restart. Anything inspecting forged-tool state should read from the DB, not from the live registry.

## Off-repo references

- Architectural spec: `~/.claude/plans/chemos-knowledge-intelligence-tranquil-marshmallow.md`.
- Whitepapers in `documentation/` (tracked): pharma autonomous-agents whitepaper + NemoClaw / Paperclip / Hermes technical review. Canonical rationale source.

## Status

`v1.0.0-claw` tagged. All harness phases A–F.2 complete. Plan: `~/.claude/plans/go-through-the-three-vivid-sunset.md`.

**What's live (no flag needed):** ReAct harness, 29 builtin hooks, 99 builtins, YAML hook system, tool forging (forge → SHADOW → VALIDATING → ACTIVE), DSPy GEPA optimizer, skill promotion, synthesis-campaign orchestration (`single_experiment | library_synthesis | screening | bo_campaign | bo_or_die`), mock ELN (port 8013) + LOGS-SciY (port 8016), chemistry profile MCPs (askcos/aizynth/chemprop/xtb/synthegy-mech/sirius 8007–8012), knowledge-wiki phases 0–4b (tables, projectors, builtins, linter, wiki_kg, search integration, `/wiki` slash verb).

**Flagged off by default:** `wiki.enabled` (wiki builtins gated at call time); `kg.auto_extraction.enabled` (tool-invocation-emitter + tool_result_extractor projector — Phase 0 scaffold, no extractors yet).

**Known stubs (return 501):** g-xTB binary not bundled (`validate_energies`); REINVENT in mcp_genchem (`/reinvent_run`). Use `scaffold_decorate` / `bioisostere_replace` / `fragment_grow` for now.

**In progress:** Universal knowledge accumulation Phases 1–7 (per-source extractors, investigation scorer, anomaly/pattern detectors); knowledge-wiki Phase 5 (Grafana panels). Tracked in `BACKLOG.md` and `docs/plans/`.

ADRs: `docs/adr/`. Design doc: `~/.claude/plans/chemos-knowledge-intelligence-tranquil-marshmallow.md`.

## Test counts (current branch)

Run `make test-counts` to regenerate current numbers. The integration trio (`etag-conflict`, `chained-execution`, `reanimator-roundtrip`) needs Docker — the testcontainer harness in `services/agent-claw/tests/helpers/postgres-container.ts` self-skips when Docker is unavailable.

`schema_version` is recorded by the `make db.init` loop (one row per applied init file, `ON CONFLICT DO NOTHING`). The Makefile loop is the source of truth.

## Harness primitives

The agent harness (`services/agent-claw/`) has 16 lifecycle hook points and 29 registered builtin hooks (`MIN_EXPECTED_HOOKS = 29`). **`loadHooks(lifecycle, deps)`** in `services/agent-claw/src/core/hook-loader.ts` is the **single registration path** at startup; YAML files in `hooks/` are the source of truth, and every hook name in YAML must have a matching `BUILTIN_REGISTRARS` entry. The orphan `buildDefaultLifecycle()` factory was removed in Phase 1B — every harness call path (`/api/chat`, `/api/chat/plan/approve`, `/api/sessions/:id/plan/run`, `/api/sessions/:id/resume`) plus sub-agents read the global lifecycle.

| Hook | When | Built-ins |
|---|---|---|
| `session_start` | Session creation | `session-events` (telemetry) |
| `session_end` | Session finalisation | `session-end-telemetry` ‡, `session-sandbox-close` (closes E2B sandbox cached on scratchpad) |
| `user_prompt_submit` | Before a user turn | `user-prompt-submit-telemetry` ‡ (length-only — never logs prompt body) |
| `pre_turn` | Before LLM call | `init-scratch`, `apply-skills` |
| `pre_tool` | Before a tool runs | `budget-guard`, `foundation-citation-guard`, `wiki-human-block-guard` (denies `upsert_article` bodies authoring `<!-- human:begin -->` markers — ADR 012), `scheduled-substance-gate` (denies CWC Schedule-1 / asks DEA Schedule-I + EAR Cat 1C — gap-plan H0.9), `loop-detector` |
| `post_tool` | After a tool returns | `anti-fabrication`, `tag-maturity`, `source-cache`, `detect-mcp-leakage`, `fact-id-consistency-guard`, `compute-result-writer` (order 110; gated by `chemistry.compute_results.persist`), `tool-invocation-emitter` (also post_tool_failure; gated by `kg.auto_extraction.enabled`, default OFF), `redact-tool-output` (order 200 — runs LAST so others see unredacted output for fact-ID harvesting / artifact stamping / source caching) |
| `post_tool_failure` | After a tool throws | `post-tool-failure-telemetry` ‡ (warn level) |
| `post_tool_batch` | After a parallel readonly batch resolves | `post-tool-batch-telemetry` ‡ |
| `permission_request` | Resolver in `core/permissions/resolver.ts` (Phase 6) | `permission` (no-op default). Resolver wired in `core/step.ts` and engaged on every harness call site (`chat.ts`, `chained-harness.ts`, `sub-agent.ts`, `deep-research.ts`, `plan.ts`) since the 2026-05-04 baseline. |
| `subagent_start` / `subagent_stop` | Around sub-agent runHarness | `subagent-start-telemetry` ‡ / `subagent-stop-telemetry` ‡ |
| `task_created` / `task_completed` | `manage_todos` mutations | `task-created-telemetry` ‡ / `task-completed-telemetry` ‡ |
| `pre_compact` | Context > 60% of budget | `compact-window` (Haiku compactor) |
| `post_compact` | After compaction | `post-compact-telemetry` ‡ (logs shrinkRatio) |
| `post_turn` | Loop exit; before SSE close — fires inside `runHarness`'s finally so scratchpad / redaction work runs before the route's reply ends | `redact-secrets` (defense-in-depth output scrub) |

‡ **Lifecycle-telemetry stub.** Cluster F (2026-05-08) added structured-log handlers for the 9 dispatched-but-previously-unimplemented lifecycle points. Each emits a single `info` (or `warn` for `post_tool_failure`) line bound to component `lifecycle-telemetry` and returns `{}` (no decision contribution). Source: `services/agent-claw/src/core/hooks/lifecycle-telemetry.ts` + `hooks/<point>-telemetry.yaml`. To replace with custom behaviour (Langfuse session emit, OTel span event, Slack notification, etc.), swap the entry in `BUILTIN_REGISTRARS` — the lifecycle.on() shape and YAML name stay identical. Adding a SECOND handler at the same point is additive (multiple registrars aggregate via `deny > defer > ask > allow`).

**Lifecycle is a process-wide singleton** in `services/agent-claw/src/core/runtime.ts`. At startup `index.ts` calls `loadHooks(lifecycle, deps)`, which iterates `hooks/*.yaml` and registers each entry from `BUILTIN_REGISTRARS`. All harness call paths import the same singleton. `core/session-state.ts` exports `hydrateScratchpad` and `persistTurnState` for the shared rehydrate / save patterns.

Hook callbacks follow the Claude Agent SDK shape — `(input, toolUseID, { signal: AbortSignal }) => Promise<HookJSONOutput>` — and aggregate via `deny > defer > ask > allow`. Per-call AbortController; 60 s default timeout. See ADRs [007](docs/adr/007-hook-system-rebuild.md), [008](docs/adr/008-collapsed-react-loop.md), [009](docs/adr/009-permission-and-decision-contract.md), [010](docs/adr/010-deferred-phases.md), and [`docs/PARITY.md`](docs/PARITY.md).

Hook files: `hooks/*.yaml` (definition) + `services/agent-claw/src/core/hooks/*.ts` (implementation).

Adding a hook:
1. Implementation in `services/agent-claw/src/core/hooks/<name>.ts` — export `register<Name>Hook(lifecycle, ...deps)`.
2. YAML at `hooks/<name>.yaml` (declares the lifecycle phase).
3. Add to `BUILTIN_REGISTRARS` in `core/hook-loader.ts`.
4. Vitest under `services/agent-claw/tests/unit/`.
5. Bump `MIN_EXPECTED_HOOKS` (currently 29) in `services/agent-claw/src/bootstrap/start.ts`.
   If also adding a builtin tool, bump `MIN_EXPECTED_BUILTINS` (currently 99) in the same file.

The loader returns `HookLoadResult.skipped`, so YAML-without-registrar (or vice versa) surfaces at boot.
