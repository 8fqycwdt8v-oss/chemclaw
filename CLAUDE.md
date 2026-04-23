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

- **Agent reasoning loop**: pure ReAct. Model picks tools. No DAG. The agent lives in `services/agent/` (TypeScript/Mastra — Mastra not yet wired, placeholder Fastify server).
- **Tools** (retrieval, KG ops, scientific compute): exposed as MCP/REST endpoints the agent calls. Sprint 2 uses plain REST for simplicity; the MCP wrapper lands in sprint 3.
- **Plumbing** (ingestion, projectors, correction propagation, approval gates): deterministic, rule-based. Never put LLM reasoning into these paths.
- **Deep Research** and **cross-project learning** are *toolkits* the agent chooses to invoke, not fixed pipelines. Avoid adding new hard-coded "step 1 → step 2 → step 3" logic at the reasoning layer.

## Backend stack — why it looks the way it does

- **Python for scientific tools** (every MCP tool is Python): RDKit, Marker, ChemDataExtractor, DRFP, TabPFN, nmrglue, pyopenms have no TypeScript equivalents of comparable quality.
- **Node.js/TypeScript for orchestration** (agent service, Paperclip): better async model, cleaner tool schema typing, Mastra.
- **MCP is the cross-language boundary** — tools never import each other's code directly; everything is JSON over HTTP.
- **Paperclip** (Node.js, MIT) is adopted as the orchestration/approval/budget/heartbeat layer. Cap concurrent issues below 250/company (pino OOM mitigation documented in the plan).
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

Every project-scoped query must run in a transaction with `app.current_user_entra_id` set. Use the helper functions:

- **TypeScript agent**: `withUserContext(pool, userEntraId, async (client) => ...)` in `services/agent/src/db.ts`.
- **Python Streamlit**: `connect(user_entra_id)` context manager in `services/frontend/db.py`.
- **Ingestion workers and projectors**: set the user to `''` (empty string) — RLS policies treat this as "system / bypass" and are written permissively for empty context. The `chemclaw_service` role is also `BYPASSRLS` for containerized workloads.

**Never bypass RLS by connecting as the DB owner from user-facing code.** If a query returns rows the user shouldn't see, the bug is a missing or wrong `SET LOCAL`, not a missing WHERE clause.

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

## Status

- **Phase 0** (infrastructure): complete. Postgres + Neo4j via compose, schema + RLS, Streamlit skeleton, hardened Fastify agent with rate-limit, CORS allowlist, body-size cap, dev/prod user-extraction separation.
- **Phase 1** (document ingestion): core path **complete**. `doc_ingester` parses PDF (pypdf) / DOCX (python-docx + defusedxml preflight) / Markdown / plaintext → `documents` + `document_chunks` rows, emits `document_ingested` events. `chunk_embedder` projector consumes events, calls `mcp-embedder` in batches, writes BGE-M3 vectors. Agent tools `search_knowledge` (hybrid dense+sparse+RRF) and `fetch_full_document` land and are tested. SMB live scraper + inotify daemon mode deferred; current ingester runs one-shot over a mounted directory (`docker compose --profile ingest up`).
- **Phase 2** (ELN + analytical): ELN JSON importer end-to-end (file-size capped); reaction DRFP vectorizer end-to-end via `mcp-drfp` (SMILES length bounded).
- **Phase 3** (retrieval & chat): **complete**.
  - `mcp-kg` — bi-temporal KG with race-safe MERGE (uniqueness constraint on `fact_id`), confidence tiers, invalidation, temporal-point queries.
  - `mcp-embedder` — BGE-M3 text embeddings with stub-encoder for dev/test.
  - `kg-experiments` projector — deterministic UUIDv5 `fact_id`s → idempotent replay. Ungrounded compounds fall back to `ungrounded-<hash>` nodes.
  - Agent — **autonomous ReAct loop via Mastra** with LiteLLM as the model provider. Tools: `find_similar_reactions`, `canonicalize_smiles`. System prompt loaded from the `prompt_registry` table (not hardcoded) with a 60s cache; no runtime fallback — if the active prompt is missing, the agent refuses to start a turn.
  - `POST /api/chat` — SSE streaming chat endpoint. Route-level rate limit, history + per-message caps, terminal-event guarantee. Non-streaming mode available via `stream: false`.
  - `services/frontend/pages/chat.py` — Streamlit chat page consuming the SSE stream with inline tool-call panels and history trimming.
- **Phase 4** (Deep Research): **complete**.
  - `agent.deep_research_mode.v1` system prompt layered on top of `agent.system` when mode is `deep_research`.
  - Toolkit expansion: `query_kg` (direct Neo4j traversal via `mcp-kg`), `check_contradictions` (explicit CONTRADICTS edges + parallel currently-valid facts), `draft_section` (composition helper with citation-format validation), `mark_research_done` (TERMINAL tool that assembles + persists a report in `research_reports`).
  - `research_reports` table + RLS (`owner_policy`: a user sees only their own reports).
  - `ChatAgent` accepts `mode: "default" | "deep_research"`; DR mode raises `maxSteps` (×4, capped at 40) and layers the DR prompt.
  - `POST /api/deep_research` route — quarters the chat rate limit for the heavier path; same SSE wire format.
- **Phases 5–8**: pending. Cross-project reaction learning synthesis, KG correction workflow, GEPA self-improvement, OpenShift Helm, full RBAC hardening.

## Test counts (as of current sprint)

```
python3 -m pytest tests/             →  110 passed, 4 skipped (Neo4j integration, gated)
cd services/agent && npm test        →   68 passed
cd services/agent && npm run typecheck →  ok
```
