# ChemClaw Deep-Review Synthesis — 2026-05-03

Synthesised across the thirteen specialist reports under
`docs/review/2026-05-03/01-*.md` … `13-*.md`. Reports are referenced in
the master table by their two-digit prefix (e.g. `R02` = `02-db-schema.md`).

---

## TL;DR

The infrastructure landed across the Z0–Z8, QM 1–9, condition-design,
synthegy, applicability-domain, workflow-engine, optimizer and Phase
F.1/F.2 merges is **broadly well-designed and largely correct in its
foundations** — but ~25 % of new MCP / phase additions ship with at
least one production-fatal omission, and several *built-but-unwired*
infrastructure pieces (feature flags, Python config registry, permission
resolver, record_error_event, request_id correlation, Langfuse roots,
skill maturity gating) silently mislead operators into believing
features are active when they are not.

The three things to fix this week, in order, are:

1. **Restore production-startable runtime** — `workflow_engine` SQL
   placeholder bug (R01 F-03 / R04 F-2), missing `mcp-applicability-domain`
   + `mcp-green-chemistry` from `SERVICE_SCOPES` (R01 F-01), port-8015
   collision between `mcp-yield-baseline` and `mcp-genchem` (R01 F-02),
   plus the `kg_source_cache` UUID-cast writer bug that silently dead-letters
   every source-fact event (R07 F.1).
2. **Close the multi-tenant data-leak in workflow / queue / screen / qm**
   tables — none of `workflows`, `workflow_runs`, `workflow_events`,
   `workflow_state`, `workflow_modifications`, `gen_runs`, `task_queue`,
   `task_batches`, `chemspace_screens`, `qm_*` (8 tables), or
   `user_project_access` enable RLS, despite carrying `created_by` /
   user identity columns (R02 P0-2/3/4, R04 F-1, R08 HIGH#2).
3. **Wire MCP auth env into `mcp-eln-local` + `mcp-logs-sciy`** (R03 F-3)
   so the six ELN/SDMS builtins do not 401 in any deployment with
   `MCP_AUTH_SIGNING_KEY` set.

The dominant meta-pattern is **"infrastructure landed; adoption did
not."** Every Wave-1 P0 / P1 has the same signature: the registry,
table, hook, or function exists, the seed/CHECK exists, but the call
site that would prove the wiring is end-to-end is missing.

---

## Meta-Patterns

These three patterns recur across nearly every report and explain why
the headline test count (~1900 passing) overstates true coverage.

### MP-1 — Built-but-unwired

A registry, hook, table or function lands; a single seed/test exists;
no production code consumes it.

| Surface | Built | Wired? | Evidence |
|---|---|---|---|
| `feature_flags` table + `isFeatureEnabled` helper | 4 seeded rows + admin route | **No production reader** | R09 §1B, R12 F-12.5 |
| Python `ConfigRegistry` (`services/common/config_registry.py`) | full implementation | **0 callers** outside docs | R09 C1 |
| `record_error_event(...)` SQL function | full body, RLS, NOTIFY trigger, grants | **0 callers** | R10 F-5 |
| Langfuse / OTel root spans (`startRootTurnSpan`) | implementation in observability/otel.ts | called from **`/api/chat` SSE only** | R10 F-3 |
| Permission resolver | `core/permissions/resolver.ts` + `permission` hook + DB rows | `/api/chat` SSE only — 7 surfaces bypass | R12 F-12.1, R05 PARITY-1, R03 F12 |
| `skill_library.maturity` + `shadow_until` columns | added in PR-8 | loader ignores both | R12 F-12.2 |
| `request_id` correlation through projectors | reader at `base.py:296-302` | **0 writers populate it** | R07 F.9, R10 F-4 |
| `record_error_event` + `error_events.id` NOTIFY pipeline | DB-side ready | unwired | R10 F-5 |
| `enforce_user_context()` helper + `log_rls_denial()` | defined or hinted in `19_observability.sql` | **0 callers** / does not exist | R02 P2-14 |
| Structured error envelope (`errors/envelope.ts:toEnvelope`) | full implementation | called by 1 site (`bootstrap/auth.ts`) | R05 ENVELOPE-1 |
| `hypothesis_status_changed` projector branch | `kg_hypotheses._handle_status_changed` | **no emitter exists** | R07 F.7 |
| `experiment_imported` event | three subscribers | **only emitter is import-broken legacy importer** | R02 P0-1, R07 F.2 |
| `audit_partition_maintainer` cron | comment naming the daemon | **service does not exist** | R01 F-11, R02 P1-6 |
| `appendAudit` on admin-mutating routes | helper + 5 routes use it | **4 routes (`forged-tools`, `skills`, `eval`, `optimizer`) bypass** | R10 F-7 |
| `loop` / `parallel` / `conditional` / `sub_agent` workflow step kinds | accepted by Zod | engine returns `step_succeeded` no-op | R08 HIGH#1 |
| `redaction_patterns.is_pattern_safe()` DB CHECK | claimed by CLAUDE.md | **only `length<=200`** is enforced; nested-quantifier ReDoS unguarded | R02 P1-7, R04 F-7 |

Net result: **a route can claim a security control runs and have nothing
to call out the gap.** Every meta-bug below is a special case of this.

### MP-2 — Merge-time partial-update of cross-cutting maps

When a feature branch lands a new MCP service, ≥ 1 of
{`SERVICE_SCOPES` (TS), `SERVICE_SCOPES` (Py), `config.ts` URL default,
`docker-compose.yml`, `infra/helm/values.yaml`,
`chemistry-deployments.yaml`, `.env.example`, `scopes.py`, builtin
registration in `bootstrap/dependencies.ts`} is missed. Wave 1 found
≥ 5 distinct landings each missing at least one.

| Service | Missed | Evidence |
|---|---|---|
| `mcp-applicability-domain`, `mcp-green-chemistry` | both `SERVICE_SCOPES` maps | R01 F-01 |
| `mcp-genchem`, `mcp-yield-baseline` | port collision (8015) | R01 F-02, R03 F1 |
| `mcp-genchem` | `config.ts` (8023) ↔ compose (8015) drift | R03 F5 |
| `mcp-eln-local`, `mcp-logs-sciy` | `MCP_AUTH_SIGNING_KEY` env | R03 F3 |
| 11 services | absent from helm chart | R01 F-05 |
| `gepa-runner` ↔ `mcp-xtb` | port 8010 collision | R03 F2 |
| `skill-promoter` ↔ `mcp-synthegy-mech` | port 8011 collision | R03 secondary |
| `conditions-normalizer` projector | absent from compose entirely | R03 F6 |
| `inchikey_from_smiles` | declared by 2 skills, never registered | R12 F-12.3 |

The fix that closes the entire bug class is the **service registry**
sketched in R09 §5 (`services/agent-claw/src/config/services.ts` plus
codegen + a pact test).

### MP-3 — Tests-pass-but-prod-breaks

A unit test mocks the DB or HTTP boundary; the bug lives at the
boundary; CI is green forever.

| Defect | Test layer that hides it | Evidence |
|---|---|---|
| `kg_source_cache` UUID-cast bug | both writer (TS) and projector (Py) tests mock the DB | R07 F.1, R11 §"Mock-vs-Real" |
| `workflow_engine` `$1::text` placeholder bug | only helper tests; `_advance_run` not exercised | R01 F-03, R08 §"Test gap inventory" |
| `chemprop` accepts invalid SMILES → 500 | TestClient happy-path only | R06 CRIT-9 |
| `qm_kg` sync Neo4j driver crashes loop on transient error | mocked driver | R07 F.4 |
| Eight `tests/unit/test_mcp_doc_fetcher.py` failures | CI runs an explicit allowlist; broken tests excluded | R11 §"tests/unit failures" |
| Helper-only coverage in `services/workflow_engine/tests/` (4 tests, all on `_resolve_jmespath` / `_tool_url`) | no `_advance_run` / `_sweep` / `_finish` / step-failed tests | R11 §"Coverage Gaps" |
| Queue worker has zero tests on `_lease_one`, `_sweep_all`, `_maybe_retry`, `_fail` | only registry shape + JWT minting tested | R11 §"Coverage Gaps" |
| Golden set is 15 placeholder entries with `expected_fact_ids: []` | no harness consumes it | R11 §"Golden-Set Integrity" |

Fix-shape: **fewer mocks at the DB boundary, not more tests**. The
testcontainer pattern already used by the integration trio
(`etag-conflict`, `chained-execution`, `reanimator-roundtrip`) is the
template.

---

## Severity-renormalised findings — Master Table

The 13 reports use heterogeneous severity vocabularies (P0/P1, H/M/L,
HIGH/MEDIUM/LOW, D0–D3, F-1/M01/etc.). Below they are renormalised to a
single P0/P1/P2/P3 scale per the rubric in the brief, with cross-report
corroboration captured in the *Corroborated-by* column.

Severity rubric (applied uniformly):
- **P0** — broken now in a prod-equivalent setup: data leak, service
  cannot start / is fatal at first use, security control bypassed.
- **P1** — degrades under load / over time / specific actions; defense-
  in-depth gap; correctness drift not yet user-visible.
- **P2** — maintainability / drift / built-but-unwired infrastructure.
- **P3** — cosmetic, doc, naming.

Three-corroboration findings are **bolded**.

### P0 — broken in production-equivalent setup

| ID | Severity | Domain | One-line summary | File:line(s) | Corroborated-by | PR-cluster |
|---|---|---|---|---|---|---|
| **M01** | P0 | Runtime / SQL | `workflow_engine` mixes asyncpg `$N::type` placeholders into psycopg3 cursors → every state UPDATE / event APPEND / `_finish` raises at runtime | `services/workflow_engine/main.py:168-179, 280-290, 300-310` | R01 F-03, R04 F-2, R08 §"Test gap"  | CRITICAL-RUNTIME |
| **M02** | P0 | Auth / Registry | `mcp-applicability-domain` + `mcp-green-chemistry` missing from BOTH `SERVICE_SCOPES` maps → JWT mint throws on every call when `MCP_AUTH_SIGNING_KEY` is set | `services/agent-claw/src/security/mcp-token-cache.ts:26-47`; `services/mcp_tools/common/scopes.py:20-41` | R01 F-01, R09 C0  | CRITICAL-RUNTIME |
| **M03** | P0 | Compose / Ports | Duplicate host port `8015:8015` — `mcp-yield-baseline` AND `mcp-genchem` under the same `chemistry` profile → second container fails to start | `docker-compose.yml:1098, 1226` | R01 F-02, R03 F1, R08 LOW#7  | CRITICAL-RUNTIME |
| **M04** | P0 | RLS / Workflow | `workflows`, `workflow_runs`, `workflow_events`, `workflow_state`, `workflow_modifications` have NO RLS; `chemclaw_app` reads/writes cross-tenant via `workflow_inspect`, `workflow_run`, `workflow_modify`, `workflow_replay` | `db/init/29_workflows.sql:1-153`; `services/agent-claw/src/core/workflows/client.ts` (`withSystemContext`) | R02 P0-3, R04 F-1, R08 HIGH#2  | RLS-HARDENING |
| **M05** | P0 | RLS / Queue+Gen+Screen | `gen_runs`, `gen_proposals`, `task_queue`, `task_batches`, `chemspace_screens`, `chemspace_results`, `compound_*` Phase 4-7 tables ship without `ENABLE/FORCE RLS` despite carrying `created_by` and `payload` JSONB user inputs | `db/init/25–28_*.sql` | R01 F-04, R02 P0-3, R04 F-1, R08 HIGH#2 | RLS-HARDENING |
| **M06** | P0 | RLS / QM | Eight `qm_*` tables (`qm_jobs`/`qm_results`/`qm_conformers`/...) lack ENABLE/FORCE RLS; `chemclaw_app` SELECT granted with no row gate | `db/init/23_qm_results.sql:194-207` | R02 P0-2 | RLS-HARDENING |
| **M07** | P0 | RLS / RBAC base table | `user_project_access` has no RLS — any authenticated `chemclaw_app` user reads the whole RBAC table including foreign-team identifiers | `db/init/01_schema.sql:285-292` | R02 P0-4 | RLS-HARDENING |
| **M08** | P0 | Event sourcing | `experiment_imported` event has NO live emitter; only writer is `services/ingestion/eln_json_importer.legacy/importer.py:258` which is itself import-broken — three projectors (`reaction_vectorizer`, `kg_experiments`, `conditions_normalizer`) silently never run on real ingestion | services as named | R02 P0-1, R07 F.2 | EVENT-SOURCING-CORRECTNESS |
| **M09** | P0 | Event sourcing | `kg_source_cache` projector receives ZERO events because the writer at `core/hooks/source-cache.ts:370-378` puts a non-UUID string (`"<system_id>:<subject_id>"`) into `ingestion_events.source_row_id UUID` → INSERT raises at runtime; unit test mocks the DB so CI passes | `services/agent-claw/src/core/hooks/source-cache.ts:370-378`; `tests/unit/hooks-source-cache.test.ts:30-36` | R07 F.1, R11 §"Stub-mocked DB writes" | EVENT-SOURCING-CORRECTNESS |
| M10 | P0 | Auth env | `mcp-eln-local` + `mcp-logs-sciy` compose entries omit `MCP_AUTH_SIGNING_KEY` → 401 on every call in any deploy where the key is set; six ELN/SDMS builtins permanently broken | `docker-compose.yml:1341-1364, 1373-1400` | R03 F3, R13 D1 | AUTH-EVERYWHERE |
| M11 | P0 | Auth env | `mcp-yield-baseline` calls `mcp-drfp` and `mcp-chemprop` without bearer tokens → 401 in any prod-shaped deploy; `predict_yield_with_uq` and `design_plate` silently broken | `services/mcp_tools/mcp_yield_baseline/main.py:115-138` | R03 F4, R06 (cross-svc auth) | AUTH-EVERYWHERE |
| M12 | P0 | CI / Test integrity | 11 broken tests in `tests/unit/test_mcp_doc_fetcher.py` + tabicl files have rotted silently because `.github/workflows/ci.yml:92-102` runs an explicit allowlist that excludes them; the broken file tested SSRF defenses | `.github/workflows/ci.yml:92-102`; `tests/unit/test_mcp_doc_fetcher.py` | R11 §"tests/unit failures" | TEST-INTEGRITY |
| M13 | P0 | Helm | 11 services merged in the last two weeks (yield-baseline, plate-designer, ord-io, reaction-optimizer, applicability-domain, green-chemistry, genchem, crest, synthegy-mech, workflow-engine, queue-worker) absent from `infra/helm/templates/chemistry-deployments.yaml` → Helm-based deploys silently miss them | `infra/helm/templates/chemistry-deployments.yaml` | R01 F-05, R09 C0 | CRITICAL-RUNTIME |
| M14 | P0 | Compose | `conditions-normalizer` projector exists on disk but has NO compose entry under any profile → the projector populating canonical reaction conditions never runs | `services/projectors/conditions_normalizer/main.py`; `docker-compose.yml` (absent) | R03 F6 | CRITICAL-RUNTIME |
| M15 | P0 | Compose | `workflow-engine` and `queue-worker` services have **no docker-compose entry under any profile** → cannot be started by `make up.full` | `docker-compose.yml` (absent) | R08 HIGH#3 | CRITICAL-RUNTIME |

(R08 HIGH#3 says "no compose entry"; R03 §"Service Inventory" lists them.
Cross-reading suggests they were added in commit `c72dd92` but R08
verified absence — see "Open Questions" below.)

### P1 — fragile / degrades / defense-in-depth

| ID | Severity | Domain | One-line summary | File:line(s) | Corroborated-by | PR-cluster |
|---|---|---|---|---|---|---|
| **M16** | P1 | Permissions | Permission resolver only fires for SSE branch of `/api/chat`; 7 other surfaces bypass (chat-non-streaming, plan/approve, sessions plan/run, sessions resume, internal-resume, deep-research SSE+non-stream, sub-agents) — `permission_policies` deny rows silently inert | `services/agent-claw/src/routes/chat.ts:405` (only site) | R01 F-06, R05 PARITY-1, R12 F-12.1, R03 F12, R13 D0 (CLAUDE.md docs are also wrong) | PERMISSIONS-ENFORCE-EVERYWHERE |
| M17 | P1 | Auth consistency | TS `mcp-token-cache.ts` throws on missing scope; Python `mcp_token_cache.py` warns and mints unscoped → silent 403 surfaced one HTTP hop later | `services/agent-claw/src/security/mcp-token-cache.ts:90-97` vs `services/mcp_tools/common/mcp_token_cache.py:73-80` | R01 F-07 | AUTH-EVERYWHERE |
| M18 | P1 | Audit partition | `audit_log` only bootstrapped with current+2 month partitions; the `services/optimizer/audit_partition_maintainer/` daemon named in the comment **does not exist** → audited writes 90+ days from `make db.init` raise no-partition; trigger forwards to `error_events` (which itself never has callers — see M30) | `db/init/19_observability.sql:236-262` | R01 F-11, R02 P1-6 | RLS-HARDENING |
| M19 | P1 | Async correctness | 11 MCP services declare `async def` handlers that call **synchronous** heavy work (RDKit subprocess, sync httpx, sync psycopg, sync ML model load) — under load every request blocks the event loop, including `/healthz` | `mcp_xtb/main.py:158, 220, 287, 422, 507, 656, 732, 787, 852, 929`; `mcp_crest`, `mcp_sirius`, `mcp_chemprop`, `mcp_aizynth`, `mcp_askcos`, `mcp_genchem`, `mcp_drfp`, `mcp_rdkit`, `mcp_green_chemistry`, `mcp_doc_fetcher` | R06 CRIT-1..3,5..9 + HIGH-2,5,7,8 | MCP-PYTHON-CORRECTNESS |
| M20 | P1 | Async correctness | Per-request reconstruction of expensive resources: `AiZynthFinder`, `AskCOSClient`, `MPNN.load_from_file`, `Chem.MolFromSmarts` (Bretherick, every reactant), `ord_schema` re-import, `psycopg.connect` per call, `FittedPca` from disk | `mcp_aizynth/main.py:49-61, 91`; `mcp_askcos/main.py:52-64, 100, 153, 250`; `mcp_chemprop/main.py:55-80`; `mcp_green_chemistry/main.py:291-312`; `mcp_ord_io/main.py:88-91, 139-142`; `mcp_genchem/main.py:118-155`; `mcp_logs_sciy/backends/fake_postgres.py:104-113`; `mcp_tabicl/main.py:96-99` | R06 CRIT-4..8 + MED-7..9 | MCP-PYTHON-CORRECTNESS |
| M21 | P1 | Async correctness | `qm_kg` projector uses **sync** `from neo4j import GraphDatabase` driver inside `async def` event loop; every projection blocks LISTEN; no try/except in `_listen_loop_qm` so transient Neo4j blip crashes container | `services/projectors/qm_kg/main.py:152-153, 215, 261-268` | R07 F.3, F.4 | MCP-PYTHON-CORRECTNESS |
| M22 | P1 | Schema drift | `redaction_patterns` lacks the `is_pattern_safe()` DB CHECK that CLAUDE.md claims is enforced — only `length(pattern_regex) <= 200` is. App-layer `is_pattern_safe` rejects 7 unbounded shapes but allows `(a+)+` / `(a|a)*` ReDoS | `db/init/20_redaction_patterns.sql:37`; `services/litellm_redactor/dynamic_patterns.py:38-65` | R02 P1-7, R04 F-7 | SECURITY-HARDENING |
| M23 | P1 | Auth tokens | `verifyBearerHeader` in internal-resume route does NOT pass `expectedAudience`; reanimator mints with no `aud` — defense-in-depth replay gap | `services/agent-claw/src/routes/sessions-handlers.ts:375-383`; `services/agent-claw/src/security/mcp-tokens.ts:140-220`; `services/optimizer/session_reanimator/main.py:191-198` | R04 F-11, F-18 | AUTH-EVERYWHERE |
| M24 | P1 | Security / Pino | TS Pino redact list deliberately omits `err.message` / `err.stack`; Postgres + UpstreamError messages embed SMILES / compound codes / NCE-IDs verbatim → leak to Loki/Grafana | `services/agent-claw/src/observability/logger.ts:48-73` | R04 F-8, R10 F-6, R13 D1 (CLAUDE.md doc says the opposite of code) | OBSERVABILITY-EVERYWHERE |
| M25 | P1 | Security / Python | `RedactionFilter._PASSTHROUGH_FIELDS` excludes `exc_info` + `exc_text`; `log.exception(...)` ships exception messages and tracebacks to Loki without redaction | `services/mcp_tools/common/redaction_filter.py:62-64` | R04 F-9, R10 F-6 | OBSERVABILITY-EVERYWHERE |
| M26 | P1 | Security / DNS | DNS-rebinding TOCTOU in `mcp_doc_fetcher`: `validate_network_host` resolves once via `getaddrinfo`, httpx then resolves again at connect; metadata-IP race | `services/mcp_tools/mcp_doc_fetcher/validators.py:115-155`; `fetchers.py:118-158` | R04 F-10 | SECURITY-HARDENING |
| M27 | P1 | Security / RLS-hardening | `LocalSubprocessSandbox` runs LLM-authored Python under the validator's UID with no isolation in production; no runtime guard refusing it outside dev | `services/optimizer/forged_tool_validator/sandbox_client.py:32-58` | R04 F-4 (carryover) | SECURITY-HARDENING |
| M28 | P1 | Security / Path | `forge_tool` accepts an LLM-controlled `name` that flows into `skill_library.name` and invocation routing; `randomUUID()` is used for the on-disk filename, but `name` itself is not allow-listed | `services/agent-claw/src/tools/builtins/forge_tool.ts:382-440` | R04 F-5 (carryover) | SECURITY-HARDENING |
| M29 | P1 | Security / Salt | `LOG_USER_SALT` Python loader silently accepts `PYTEST_CURRENT_TEST` as dev-mode signal in production; TS mirror does NOT — asymmetric leak surface | `services/mcp_tools/common/user_hash.py:42-46` | R04 F-6, R09 C1 | SECURITY-HARDENING |
| M30 | P1 | Observability sink | `record_error_event(...)` SQL function defined, granted, NOTIFY-triggered — and has **0 callers**; `error_events` table never written | `db/init/19_observability.sql:138-199`; grep across `services/` returns 0 hits | R10 F-5 | OBSERVABILITY-EVERYWHERE |
| M31 | P1 | Observability spans | Langfuse / OTel root spans only fire on `/api/chat` SSE; non-streaming chat, plan-approve, sessions plan/run, resume, internal-resume, deep-research, sub-agents all produce orphan tool spans without `prompt:agent.system` tag — defeats GEPA's tag-filter trace fetch | `services/agent-claw/src/routes/chat.ts:258` (only site) | R10 F-3 | OBSERVABILITY-EVERYWHERE |
| M32 | P1 | Logging | Six writer/runner services bypass `configure_logging` (`kg_hypotheses`, `kg_source_cache`, `session_purger`, `session_reanimator`, `gepa_runner.runner`, `skill_promoter.runner`, `forged_tool_validator.runner`) → unstructured logs bypass `LogContextFilter` + `RedactionFilter` | as listed | R10 F-2, R07 F.6 | OBSERVABILITY-EVERYWHERE |
| M33 | P1 | Observability dashboards | Grafana `projectors.json` queries `{service=~"projector-.+"}` but Promtail strips `chemclaw-` and produces `kg-experiments` / `chunk-embedder` etc — 5 of 6 panels silently empty in production | `infra/grafana/provisioning/dashboards/projectors.json`; `infra/promtail/promtail-config.yaml:50-54` | R10 F-1 | OBSERVABILITY-EVERYWHERE |
| M34 | P1 | Audit-log gap | Four legacy admin-mutating routes (`forged-tools` POST/disable, `skills` enable/disable, `eval`, `optimizer`) bypass `appendAudit` and use a duplicate ad-hoc `requireAdmin` against `user_project_access.role='admin'` instead of the canonical `admin_roles`-backed `guardAdmin` | `routes/eval.ts:75-92`; `routes/optimizer.ts:23-56`; `routes/skills.ts:24-36`; `routes/forged-tools.ts:161, 208` | R05 ADMIN-1, R10 F-7 | PERMISSIONS-ENFORCE-EVERYWHERE |
| M35 | P1 | Workflow correctness | Engine returns `step_succeeded` (not `step_failed`) for unimplemented `conditional` / `loop` / `parallel` / `sub_agent` step kinds → workflows silently produce wrong results with `success=true` | `services/workflow_engine/main.py:190-193` | R08 HIGH#1, R13 (workflow_engine docstring is also wrong) | EVENT-SOURCING-CORRECTNESS |
| M36 | P1 | Workflow concurrency | `_sweep` selects up to 100 `running` runs without `FOR UPDATE SKIP LOCKED`; two engine replicas race on the same row → `UPDATE workflow_state` overwrites; `UNIQUE(run_id,seq)` prevents duplicate events but state can be lost | `services/workflow_engine/main.py:118-140` | R08 MEDIUM#5 | EVENT-SOURCING-CORRECTNESS |
| M37 | P1 | Event sourcing | Workflow runs that complete don't emit an `ingestion_events` row → `workflow_runs.output` and `workflow_state.scope` are invisible to KG projectors. Violates "never update a derived view without an event" | `services/workflow_engine/main.py:292-311` | R08 MEDIUM#6 | EVENT-SOURCING-CORRECTNESS |
| M38 | P1 | Skill loader | Loader ignores `skill_library.maturity` and `skill_library.shadow_until` columns; CLAUDE.md's Phase E "FOUNDATION skills must clear higher gate" + shadow-serving features are unimplemented | `services/agent-claw/src/core/skills.ts:331-391` | R12 F-12.2 | CONFIG-PROVE-OUT |
| M39 | P1 | Skills inventory | `inchikey_from_smiles` referenced by `library_design_planner` + `qm_pipeline_planner` skills but **NOT registered** in `bootstrap/dependencies.ts` → LLM tries to call a nonexistent tool when either skill is active | skills as named; `bootstrap/dependencies.ts` (no entry) | R12 F-12.3 | CRITICAL-RUNTIME |
| M40 | P1 | Permissions | Resolver `ask` decision is silently downgraded to `allow` at `pre_tool` (logged + continue) — no SSE event, no UI for the user to answer | `services/agent-claw/src/core/step.ts:163-173`; `services/agent-claw/src/core/permissions/resolver.ts:101-106` | R12 F-12.4 | PERMISSIONS-ENFORCE-EVERYWHERE |
| M41 | P1 | RLS / projectors | `kg-hypotheses` ack key uses HYPHEN; every other projector uses underscore — replay-runbook command silently affects 0 rows | `services/projectors/kg_hypotheses/main.py:30` | R02 P1-11, R07 F.5, R10 §"Service-level Logging Adoption" | RLS-HARDENING |
| M42 | P1 | Schema / Trigger search_path | 5 NOTIFY trigger functions added in `23/24/27/29` lack `SET search_path = public, pg_temp` (pinning was done for the four pre-existing functions in `16_db_audit_fixes.sql §4`) | `db/init/23_qm_results.sql:177`; `24_compound_fingerprints.sql:86`; `27_job_queue.sql:63, 77`; `29_workflows.sql:76` | R02 P1-5 | RLS-HARDENING |
| M43 | P1 | Schema / Audit triggers | `audit_row_change` trigger only attached to 8 tables; `hypotheses`, `artifacts`, `reactions`, `corrections`, `feedback_events`, `paperclip_state` — all carrying user-derived state — are unaudited | `db/init/19_observability.sql:368-380` | R02 P1-8 | RLS-HARDENING |
| M44 | P1 | Schema migration | `db/migrations/202604230001_research_reports.sql` is a stale duplicate carrying the legacy fail-open `IS NULL OR = ''` policy; not on the apply path but tooling that walks `db/migrations/` will diverge | `db/migrations/202604230001_research_reports.sql:30-33` | R02 P1-9 | RLS-HARDENING |
| M45 | P1 | Confidence model | `reactions.confidence_score` and `reactions.confidence_tier` are independent (no GENERATED, no trigger) — writers that update one but not the other silently desync | `db/init/17_unified_confidence_and_temporal.sql:55-69`; `db/init/01_schema.sql:123-128` | R02 P1-10 | DB-MAINTAINABILITY |
| M46 | P1 | LiteLLM gateway | `services/litellm_redactor/Dockerfile` still pins `LITELLM_BASE_IMAGE=ghcr.io/berriai/litellm:main-v1.60.0` (moving tag, no `@sha256:` digest); 4 CVEs landed in 1.83.x | `services/litellm_redactor/Dockerfile:14-16` | R04 F-3 (carryover) | SECURITY-HARDENING |
| M47 | P1 | Queue / retry | Queue worker has no exponential backoff between retries — a transient downstream outage spins handlers at `_sweep_all` cadence (~30 s) until `max_attempts` exhausted | `services/queue/worker.py:296-313` | R08 MEDIUM#9 | EVENT-SOURCING-CORRECTNESS |
| M48 | P1 | Tests | Every Wave-1 P0 has a "passing" unit test; suite is structurally biased to false confidence — no integration test for source-cache → kg_source_cache loop, no real-Postgres test for `_advance_run`, no test for `_lease_one` CTE | as covered in R11 | R11 §"Closing Verdict" | TEST-INTEGRITY |
| M49 | P1 | Compose / healthchecks | LiteLLM proxy is commented out in compose; multiple services consume `LITELLM_BASE_URL` (`contextual-chunker`, `conditions-normalizer`, `synthegy_mech`, `gepa-runner`) — silent-fall-through to direct provider keys bypassing redactor when proxy unreachable | `docker-compose.yml:581-595` | R03 F8 | CRITICAL-RUNTIME |
| M50 | P1 | Compose / probe | `kg-source-cache` projector starts with no `depends_on: mcp-kg`, no healthcheck → startup catch-up POSTs to KG can race the KG's readiness | `docker-compose.yml:1403-1424` | R03 F7 | CRITICAL-RUNTIME |
| M51 | P1 | Async correctness | `mcp_chemprop` does NOT validate SMILES via RDKit before pushing into chemprop's loader → invalid SMILES surface as 500 from chemprop traceback rather than `ValueError → 400` | `services/mcp_tools/mcp_chemprop/main.py:111-132, 156-171` | R06 CRIT-9 | MCP-PYTHON-CORRECTNESS |
| M52 | P1 | DR un-redacted leak | Deep-research SSE sink does NOT strip `onAwaitingUserInput` like `chat.ts` does → an `ask_user` question containing a SMILES leaks to wire un-redacted | `services/agent-claw/src/routes/deep-research.ts:213` (sink build); `streaming/sse-sink.ts:55-72` | R12 F-12.12 | OBSERVABILITY-EVERYWHERE |

### P2 — built-but-unwired / drift / maintainability

| ID | Severity | Domain | One-line summary | File:line(s) | Corroborated-by | PR-cluster |
|---|---|---|---|---|---|---|
| M53 | P2 | Config infra | Python `ConfigRegistry` (`services/common/config_registry.py`) has 0 consumers; only `agent.max_active_skills` consumes the TS registry | `services/common/config_registry.py`; `services/optimizer/skill_promoter/promoter.py:33-35` | R09 C1, R05 §"process.env audit" | CONFIG-PROVE-OUT |
| M54 | P2 | Feature flags | `feature_flags` table has 4 seeded rows; **none** are read by production code; admin toggling them has no effect | `db/init/22_feature_flags.sql:62-80`; grep `isFeatureEnabled` returns admin route only | R09 C1 | CONFIG-PROVE-OUT |
| M55 | P2 | Redaction cache | `admin-redaction.ts` doesn't (and structurally can't) call `.invalidate()` — loader lives in the LiteLLM-gateway container; admins see a successful PATCH with up to 60 s of staleness and no signal | `services/agent-claw/src/routes/admin/admin-redaction.ts:120-200` | R09 C1 | CONFIG-PROVE-OUT |
| M56 | P2 | DSN drift | Three concurrent DSN env vars (`POSTGRES_DSN`, `REDACTOR_PG_DSN`, `CHEMCLAW_SERVICE_DSN`) plus the multi-component variant; some services accept DSN, others rebuild from components; none documented | as covered in R09 §1D | R09 C1 | CONFIG-PROVE-OUT |
| M57 | P2 | Service registry | Adding a new MCP touches 6+ files with no enforcement; ≥ 5 distinct landings missed ≥ 1 file. Sketch in R09 §5 (`services/agent-claw/src/config/services.ts` + codegen + pact test) closes the entire bug class | as cited | R09 §5, R01 F-01/F-05, R03 F1/F3 | SERVICE-REGISTRY |
| M58 | P2 | SQL filename collisions | Six prefix collisions (`02_*`, `18_*`, `19_*`×4, `20_*`, `21_*`); apply order resolves only because lex order happens to match dependency order | `db/init/02_*`, `18_*`, `19_*`, `20_*`, `21_*` | R01 F-08 | DB-MAINTAINABILITY |
| M59 | P2 | SQL self-INSERT | Files 23-29 self-INSERT into `schema_version` while Makefile loop also inserts — double rows; files 02-22 + 30-31 don't self-INSERT | `db/init/23_qm_results.sql:221`; `24-29_*.sql` ends | R01 F-10, R02 P3-23 | DB-MAINTAINABILITY |
| M60 | P2 | Bootstrap admins | `chemclaw.bootstrap_admins` setting referenced by `18_admin_roles_and_audit.sql:156` but no wrapper script ever sets it — the DO block is dead code | `db/init/18_admin_roles_and_audit.sql:152-167` | R01 F-09 | DB-MAINTAINABILITY |
| M61 | P2 | Schema patterns | Catalog-RLS convention violated by `tools` and `mcp_tools` (no ENABLE/FORCE) | `db/init/02_harness.sql:13-40` | R02 P2-12 | RLS-HARDENING |
| M62 | P2 | Schema patterns | Redundant SELECT-only policies on `nce_projects`, `synthetic_steps`, `experiments` (FOR ALL with same predicate already covers them) | `db/init/12_security_hardening.sql:260-269 vs 298-314` | R02 P2-13 | DB-MAINTAINABILITY |
| M63 | P2 | Dead code | `enforce_user_context()` defined; 0 callers. Header references nonexistent `log_rls_denial()` | `db/init/19_observability.sql:423-458, 23-28` | R02 P2-14 | DB-MAINTAINABILITY |
| M64 | P2 | Bi-temporal shape divergence | `reactions(valid_from, valid_to, invalidated)` vs `hypotheses(valid_from, valid_to, refuted_at)` vs `artifacts(valid_from, superseded_at, NO valid_to)` — cross-table "live as of T" needs three predicates | `db/init/17_unified_confidence_and_temporal.sql:20-23, 34-37, 93-95` | R02 P2-16 | DB-MAINTAINABILITY |
| M65 | P2 | Naming | `compound_class_assignments.confidence` diverges from `confidence_score` used elsewhere | `db/init/25_compound_ontology.sql:44` | R02 P2-17 | DB-MAINTAINABILITY |
| M66 | P2 | Constraint shape | `paperclip_state_session_id_shape` CHECK is `NOT VALID`; legacy rows skipped — future `VALIDATE CONSTRAINT` could fail | `db/init/16_db_audit_fixes.sql:386-389` | R02 P2-18 | DB-MAINTAINABILITY |
| M67 | P2 | TS error envelope | `errors/envelope.ts:toEnvelope` + `errors/codes.ts` consumed by 1 site only (`bootstrap/auth.ts`); 30+ raw `reply.code(N).send({error: ...})` sites bypass the envelope; SSE error frames likewise skip `trace_id`/`request_id` | `src/errors/envelope.ts:70`; many routes | R05 ENVELOPE-1, R10 §"audit-log coverage" | TS-MAINTAINABILITY |
| M68 | P2 | TS dedup | Three near-identical `isAbortError` predicates (one also checks `code === "ABORT_ERR"`, others don't) | `src/core/harness.ts:40`; `src/routes/chat-helpers.ts:74`; `src/routes/deep-research.ts:271`; `src/observability/with-retry.ts:60` | R05 DEDUP-1 | TS-MAINTAINABILITY |
| M69 | P2 | TS dedup | Paperclip release-block duplicated 4× (chat.ts, chat-non-streaming.ts, chained-harness.ts ×2) | as listed | R05 DEDUP-2 | TS-MAINTAINABILITY |
| M70 | P2 | TS dedup | Continue-prompt strings duplicated (`sessions-handlers.ts:36-38` vs `chained-harness.ts:282-284`); reservation defaults duplicated (`chat-paperclip.ts:43-44` vs `chained-harness.ts:150-151`) | as listed | R05 DEDUP-3, DEDUP-4 | TS-MAINTAINABILITY |
| M71 | P2 | TS dedup | `feedback_events` insert path duplicated — `chat-helpers.ts:recordFeedback` writes 4 cols; `feedback.ts:insertFeedback` writes 6 cols (incl. `prompt_name`/`prompt_version`); `/feedback` slash silently loses prompt linkage | as listed | R05 DEDUP-5 | TS-MAINTAINABILITY |
| M72 | P2 | TS / dead exports | `getJson` (no callers), `withRetry` (no callers), `assertWithinWorkspace` (no callers), `buildSandboxClient` (test-only), `parseForgedArgs`, `crossModelAgreement`, `extractFactIds`, `jaccardSimilarity`, `PlanStepEvent`, `PlanReadyEvent`, `qm-cache.ts:*`, `shouldCompact` | as listed | R05 DEAD-1 | TS-MAINTAINABILITY |
| M73 | P2 | Probe loop | `MCP_HEALTH_PROBE_INTERVAL_MS = 60_000` hardcoded; first probe scheduled after full interval → `/readyz` returns `no_healthy_mcp_tools` for up to 60 s after startup, k8s readiness flaps | `src/bootstrap/probes.ts:14, 100-104` | R05 §Medium item | TS-MAINTAINABILITY |
| M74 | P2 | Hooks | `hooks/permission.yaml` declares `enabled: true` but only fires when a route passes `permissions:` to runHarness — operators reading the YAML believe DB-backed permissions are global; stale comments in `core/types.ts:284-287` and `core/permissions/resolver.ts:4-8` | as listed | R12 F-12.5, F-12.6 | PERMISSIONS-ENFORCE-EVERYWHERE |
| M75 | P2 | Hooks | `session_end` lifecycle phase is dispatched from `chained-harness.ts:368` but no built-in registrar / YAML exists — end-of-session telemetry has no attach point | as listed | R12 F-12.7 | TS-MAINTAINABILITY |
| M76 | P2 | Hooks | `tag-maturity` swallows DB errors silently (`try {...} catch {}`) — no log, no metric; failed artifact INSERT breaks foundation-citation-guard | `src/core/hooks/tag-maturity.ts:103-127` | R12 F-12.10 | OBSERVABILITY-EVERYWHERE |
| M77 | P2 | Sub-agent | No explicit recursion-depth counter; safety relies on `SUB_AGENT_TOOL_SUBSETS` excluding `dispatch_sub_agent` — fragile to future skill additions | `src/core/sub-agent.ts:34-53, 181-188` | R12 F-12.8, F-12.9 | PERMISSIONS-ENFORCE-EVERYWHERE |
| M78 | P2 | Tests | Workflow engine has 4 helper tests only — `_advance_run`, `_sweep`, `_exec_tool_call`, `_exec_wait`, `_finish` all untested | `services/workflow_engine/tests/test_engine.py` | R08 §"Test gap", R11 | TEST-INTEGRITY |
| M79 | P2 | Tests | Queue worker — zero tests on `_lease_one`, `_sweep_all`, `_maybe_retry`, `_fail` | `services/queue/` | R08 §"Test gap", R11 | TEST-INTEGRITY |
| M80 | P2 | Tests | Golden set is 15 placeholder entries with `expected_fact_ids: []`; no harness consumes it; promotion gate cannot ground correctness on KG fact IDs | `tests/golden/chem_qa_*.fixture.jsonl` | R11 §"Golden-Set Integrity" | TEST-INTEGRITY |
| M81 | P2 | CI | Diff-cover only runs on PR; direct push to main bypasses coverage enforcement | `.github/workflows/ci.yml:51` | R11 §"CI Configuration" | TEST-INTEGRITY |
| M82 | P2 | CI | `make test` segfaults locally on xgboost+torch cross-import; CI sidesteps by per-service installs | `services/mcp_tools/mcp_yield_baseline` + `mcp_tabicl` torch | R11 §"make test blast radius" | TEST-INTEGRITY |
| M83 | P2 | Hardcoded constants | 21 `TIMEOUT_*_MS` in `services/agent-claw/src/tools/builtins/`; CLAUDE.md mandates migration to `config_settings` — none migrated | `tools/builtins/*.ts` | R09 C2 | CONFIG-PROVE-OUT |
| M84 | P2 | Hardcoded constants | Optimizer constants explicitly named in CLAUDE.md as the canonical example (`PROMOTION_SUCCESS_RATE = 0.55`, `MIN_RUNS = 30`, `FEEDBACK_WEIGHT = 0.50`, etc.) are still hardcoded | `services/optimizer/skill_promoter/promoter.py:33-35, 254-256`; `services/optimizer/gepa_runner/metric.py:24-26`; `examples.py:19` | R09 C2 | CONFIG-PROVE-OUT |
| M85 | P2 | Auth | `mcp_tabicl` ships a parallel admin auth surface (`MCP_TABICL_ADMIN_TOKEN` env + `x-admin-token` header) instead of using JWT scopes | `services/mcp_tools/mcp_tabicl/main.py:160-174` | R06 MED-10, R09 C2 | AUTH-EVERYWHERE |
| M86 | P2 | Redaction | `redaction_patterns` seeds the EXISTING hardcoded patterns as global rows; the compiled-in `redaction.py` ALSO continues to apply them → double-fire; disabling the DB row has no effect | `services/litellm_redactor/redaction.py:127-132` + `db/init/20_redaction_patterns.sql:63-91` | R09 C2 | SECURITY-HARDENING |
| M87 | P2 | Redaction | `_NCE_PROJECT` and `_COMPOUND_CODE` patterns hardcoded in baseline are tenant-specific values that CLAUDE.md's own rule says belong in the table | `services/litellm_redactor/redaction.py:60-63` | R09 §4 | SECURITY-HARDENING |
| M88 | P2 | Common helper | `mol_from_smiles` helper still missing — duplicated 8× across mcp_rdkit/xtb/aizynth/askcos/genchem/green_chemistry/synthegy_mech/crest (chemprop has none — separate bug, M51) | as listed | R06 MED-1 | MCP-PYTHON-CORRECTNESS |
| M89 | P2 | Common helper | `_constraints.txt` consumed by 2 of 23 mcp_tools services; PR-7 fix W2.18 has bit-rotted | `services/_constraints.txt`; per-service requirements files | R06 HIGH-11 | MCP-PYTHON-CORRECTNESS |
| M90 | P2 | Tests / coverage | 4 services with 0 tests anywhere: `mcp_drfp`, `mcp_embedder`, `mcp_kg`, `mcp_rdkit` — all foundational | as listed | R06 HIGH-12 | TEST-INTEGRITY |
| M91 | P2 | Projectors | Six projectors open fresh `AsyncConnection` per `handle()` instead of reusing `work_conn` from the loop — pool churn at scale | `reaction_vectorizer:67`, `conditions_normalizer:91`, `chunk_embedder:65`, `contextual_chunker:81`, `kg_experiments:117`, `kg_hypotheses:61, 136` | R07 F.10 | MCP-PYTHON-CORRECTNESS |
| M92 | P2 | Projectors | `qm_kg._ack` writes a synthetic `ingestion_events` row that broadcasts on the main channel — every other projector picks it up, ignores, and writes an ack: 6 spurious ack rows per QM job | `services/projectors/qm_kg/main.py:240-245` | R07 F.8 | EVENT-SOURCING-CORRECTNESS |
| M93 | P2 | TS dead | `routes/sessions.ts:32-33` re-exports `runChainedHarness` for "tests + bootstrap"; ts-prune flags unused | `src/routes/sessions.ts:32-33` | R05 DEDUP-6 | TS-MAINTAINABILITY |
| M94 | P2 | TS dead | `StreamEvent` re-export at `src/routes/chat.ts:61` flagged unused | as listed | R05 DEDUP-7 | TS-MAINTAINABILITY |
| M95 | P2 | TS hardcoded | `MIN_EXPECTED_HOOKS = 11` lives in `bootstrap/start.ts:29` instead of next to `BUILTIN_REGISTRARS` in `core/hook-loader.ts` | as listed | R05 CONFIG-2 | TS-MAINTAINABILITY |
| M96 | P2 | Workflow engine | `_resolve_jmespath` is not real JMESPath — array indexing or any function call silently returns None; agent-side Zod schema calls the field "JMESPath expr" | `services/workflow_engine/main.py:249-259`; `services/agent-claw/src/core/workflows/types.ts:12` | R08 MEDIUM#7 | EVENT-SOURCING-CORRECTNESS |
| M97 | P2 | Workflow engine | `_exec_wait` opens a fresh `AsyncConnection` per 5 s poll — up to 360 short-lived connections per 30-min `wait` step | `services/workflow_engine/main.py:232-244` | R08 LOW#3 | EVENT-SOURCING-CORRECTNESS |
| M98 | P2 | DR / chat | DR route duplicates ~50 LOC of pre-harness setup (own `enforceBounds`, own request schema, own system-prompt assembly) that is identical to `chat-helpers.ts` + `chat-setup.ts` | `services/agent-claw/src/routes/deep-research.ts:43-94` | R05 DR-1 | TS-MAINTAINABILITY |
| M99 | P2 | TS / Pino redact | Pino redact list is path-based; recommended adds: `*.smiles` (broaden), `*.compound_code`, `*.nce_id`, `*.project_id`, `*.smarts`, `*.reaction_smiles`, `*.inchi`, `*.inchikey`, `*.cas`, `*.entra_id`, `*.email` | `src/observability/logger.ts:48-73` | R10 §"Pino redact list" | OBSERVABILITY-EVERYWHERE |
| M100 | P2 | Doc drift / Logger | CLAUDE.md `## Logging` says "automatically redacts `err.message`/`err.stack`"; `logger.ts:62-73` says "We deliberately do NOT redact `err.message`/`err.stack`" | `services/agent-claw/src/observability/logger.ts:62-73` vs CLAUDE.md | R05 §Low item, R10 F-8, R13 D1 | DOC-TRUTH |
| M101 | P2 | Doc drift / CLAUDE.md | Test count claims 772/102; actual is 146 test files (and ~1900 tests) | CLAUDE.md ~ line 262 / 362 | R01 F-12, R13 D0 | DOC-TRUTH |
| M102 | P2 | Doc drift / CLAUDE.md | Phase F.1 lists only 6 chemistry MCPs (8007-8012); 9 more are live at 8014, 8015, 8017-8021 | CLAUDE.md Phase F.1 | R13 D0 | DOC-TRUTH |
| M103 | P2 | Doc drift / CLAUDE.md | Permission claim "no production route does today" contradicts `chat.ts:405` | CLAUDE.md hook table line 389 | R05 COMMENT-1, R12 F-12.6, R13 D0 | DOC-TRUTH |
| M104 | P2 | Doc drift / CLAUDE.md | Streamlit frontend listed as "moved to a separate repo"; `services/frontend/{__pycache__,pages}` still on disk | `services/frontend/`; CLAUDE.md | R03 F11, R13 D0 | DOC-TRUTH |
| M105 | P2 | Doc drift / ADR | ADR 001 still references "LangGraph/Mastra agent on top" + "Mastra + Fastify"; Mastra dropped | `docs/adr/001-architecture.md` | R13 D2 | DOC-TRUTH |
| M106 | P2 | Doc drift / ADR | ADR 010 says "no production route passes a `permissions` option today"; chat.ts SSE does | `docs/adr/010-deferred-phases.md:54` | R13 D1 | DOC-TRUTH |
| M107 | P2 | Doc drift / runbook | `rotate-mcp-auth-key.md` describes a `signing_key_next` dual-key rotation that is not implemented today | `docs/runbooks/rotate-mcp-auth-key.md` | R13 D1 | DOC-TRUTH |
| M108 | P2 | Doc drift / runbook | `autonomy-upgrade.md` lists items 1+2 ("MCP Bearer-token end-to-end wire", "reanimator JWT") as pending; both are done | `docs/runbooks/autonomy-upgrade.md` | R13 D1 | DOC-TRUTH |
| M109 | P2 | Doc drift / AGENTS.md | Tool catalog missing 14+ Z-series tools (`assess_applicability_domain`, `score_green_chemistry`, all `workflow_*`, `predict_yield_with_uq`, `design_plate`, `export_to_ord`, `generate_focused_library`, `find_matched_pairs`, `query_eln_samples_by_entry`, `fetch_eln_sample`, `query_instrument_*`, `conformer_aware_kg_query`, ...) | `AGENTS.md` | R13 §AGENTS.md matrix | DOC-TRUTH |
| M110 | P2 | Doc drift / SKILL.md | 13 of 15 newly-merged skills lack `prompt.md`; only `synthegy_*` have detailed prompts; SKILL.md files list `tools:` but not failure modes / when-to-use | `skills/<id>/SKILL.md` | R13 §Skills matrix | DOC-TRUTH |
| M111 | P2 | `.env.example` | 36 env vars referenced by code missing from `.env.example`; 12 stale references to deleted vendor adapters; default mismatches (`MCP_GENCHEM_URL` 8023 vs compose 8015) | `.env.example` | R01 F-13, R09 C3, R03 F9 | CONFIG-PROVE-OUT |
| M112 | P2 | env / sandbox | `SANDBOX_MAX_NET_EGRESS` and `SANDBOX_ALLOW_NET_EGRESS` are read on adjacent lines `sandbox.ts:61-62` and OR'd — duplicate / typo | `services/agent-claw/src/core/sandbox.ts:61-62` | R09 §1C | TS-MAINTAINABILITY |
| M113 | P2 | xtb numerical | `/conformer_ensemble` weights now derived from POST-opt xtb energies and `RT(298 K) = 0.5925 kcal/mol` (legacy was pre-opt + RT≈1) — same route shape, different numbers, no version flag | `services/mcp_tools/mcp_xtb/recipes/optimize_ensemble.py:11-14, 110-124`; `main.py:969-994` | R06 HIGH-1, R08 MEDIUM#4 | MCP-PYTHON-CORRECTNESS |
| M114 | P2 | mcp_xtb refactor | `_helpers.py` and `_shared.py` duplicate `parse_energy` and `parse_gnorm` | `services/mcp_tools/mcp_xtb/_helpers.py:58-86`; `_shared.py:147-170` | R08 LOW#5 | MCP-PYTHON-CORRECTNESS |
| M115 | P2 | Hardcoded admin envvar | `chemclaw.bootstrap_admins` setting plumbing missing — DO block is dead code; bootstrap goes via `AGENT_ADMIN_USERS` env in agent-claw process | `db/init/18_admin_roles_and_audit.sql:152-167` | R01 F-09 | DB-MAINTAINABILITY |
| M116 | P2 | Stale dead branches | `checkStaleFacts` defined in `source-cache.ts:380-404`; never registered as a `pre_turn` hook | `services/agent-claw/src/core/hooks/source-cache.ts:380-404` | R03 §"Persistent" carryover | TS-MAINTAINABILITY |
| M117 | P2 | TS / process.env scattering | Direct `process.env` reads at 14 sites outside `config.ts`; `AGENT_SHADOW_SAMPLE` is parsed twice (in `config.ts:182` AND `prompts/shadow-evaluator.ts:112`) | as listed | R05 CONFIG-1, R09 §1C | TS-MAINTAINABILITY |
| M118 | P2 | Compose / health | `workflow-engine` and `queue-worker` lack healthchecks (event-loop services without HTTP port — acceptable but undocumented) | `docker-compose.yml` | R01 F-14 | CRITICAL-RUNTIME |
| M119 | P2 | TS shutdown | `app.close()` has no drain timeout; stuck SSE connection holds Fastify close until k8s SIGKILL | `src/bootstrap/start.ts:110-122` | R05 SHUTDOWN-1 | TS-MAINTAINABILITY |
| M120 | P2 | TS tsconfig | Missing strictness flags (`exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`); `tests/` excluded from typecheck | `services/agent-claw/tsconfig.json` | R05 TSCONFIG-1 | TS-MAINTAINABILITY |
| M121 | P2 | Test infra | Integration trio `describe.skipIf(!dockerAvailable)` silently skips if the runner image's Docker shifts — no explicit `services:` declaration in CI | `.github/workflows/ci.yml`; `services/agent-claw/tests/integration/*` | R11 §"Integration trio status" | TEST-INTEGRITY |
| M122 | P2 | mcp_yield_baseline | `_load_global_xgb` does not guard `booster.load_model()`; corrupt artifact crashes the lifespan | `services/mcp_tools/mcp_yield_baseline/main.py:40-62` | R06 MED-16 | MCP-PYTHON-CORRECTNESS |
| M123 | P2 | Tests | `task_queue.idempotency_key` is `BYTEA` but callers may pass hex strings — no DB-side coercion, no test verifies the contract | `db/init/27_job_queue.sql:21` | R02 P3-22, R08 LOW#4 | EVENT-SOURCING-CORRECTNESS |

### P3 — cosmetic / low-value cleanup

| ID | Severity | Domain | One-line summary | File:line(s) | Cluster |
|---|---|---|---|---|---|
| M124 | P3 | Permissive bootstrap policies | `01_schema.sql:300-339` policies use legacy `IS NULL OR = ''` permissive bypass; overridden by `12_security_hardening.sql §4` | as listed | RLS-HARDENING |
| M125 | P3 | Trigger predicate | `notify_qm_job_succeeded` predicate ordering uses `OLD.status` before TG_OP=INSERT short-circuit (safe today) | `db/init/23_qm_results.sql:178-181` | DB-MAINTAINABILITY |
| M126 | P3 | Schema retention | `error_events` non-partitioned BIGSERIAL; long-running deployments accumulate without retention | `db/init/19_observability.sql:62-73` | DB-MAINTAINABILITY |
| M127 | P3 | Test flake | Wall-clock asserts in `lifecycle-decisions.test.ts`, `hooks-redact-secrets.test.ts`, `parallel-batch.test.ts` — generous ceilings, low risk | as listed | TEST-INTEGRITY |
| M128 | P3 | TS / nice-to-have | `routes/sessions.ts:SessionsRouteDeps` has misleading optional fields (`config`, `llm`, `registry`, `paperclip`) — bootstrap always passes them | `src/routes/sessions.ts:35-48` | TS-MAINTAINABILITY |
| M129 | P3 | TS / nice-to-have | `bootstrap/dependencies.ts:asTool` cast workaround at 60+ registration sites | `src/bootstrap/dependencies.ts:175` | TS-MAINTAINABILITY |
| M130 | P3 | CORS | CORS allows `null` origin with `credentials: true` | `src/bootstrap/server.ts:48-55` | SECURITY-HARDENING |
| M131 | P3 | Internal route | Public `/api/sessions/:id/resume` trusts `x-user-entra-id`; documented as "behind auth proxy" but a misconfigured deploy with port exposed forges identity | `src/routes/sessions-handlers.ts:318-345` | SECURITY-HARDENING |
| M132 | P3 | Hooks | `hooks/source-cache.yaml` has unrecognised `tool_id_pattern` / `implementation` / `stale_check_phase` fields the loader ignores | `hooks/source-cache.yaml` | TS-MAINTAINABILITY |
| M133 | P3 | Compactor fallback | Compact-window throws on Haiku outage; harness logs and continues with un-compacted window — no fallback truncate | `src/core/hooks/compact-window.ts` | TS-MAINTAINABILITY |
| M134 | P3 | Unused imports | `compound_classifier/main.py:29` (`PermanentHandlerError`); `kg_source_cache/main.py:23-24` (psycopg/dict_row) | as listed | MCP-PYTHON-CORRECTNESS |
| M135 | P3 | Doc drift | Six other minor doc drifts (AGENTS.md "Streamlit UI" references, ADR 005 missing the new workflow tables, `local-dev.md` references stale source-system URL vars) | as listed in R13 | DOC-TRUTH |
| M136 | P3 | Supply chain | `starlette 0.48.0`, `litellm 1.82.6` in optimizer venv, `torch 2.2.2` in mcp_embedder/tabicl carry CVEs; `diskcache 5.6.3` no upstream fix | `services/optimizer/*/requirements.txt`, `services/mcp_tools/{mcp_embedder,mcp_tabicl}/requirements.txt` | SECURITY-HARDENING |

---

## PR-Cluster Backlog (ordered, with verification criteria)

Eleven clusters cover the master table. Each is sized to fit ~500 LOC
(excluding tests + generated). IDs reference the master table.

### 1. CRITICAL-RUNTIME — *make it boot in prod*

- **Goal**: every documented service can start under `docker compose
  --profile chemistry up -d` (and helm-template equivalent) without bind
  failures, missing-scope JWT errors, or runtime SQL syntax errors.
- **Includes**: M01 (workflow_engine `$N`→`%s`), M02 (SERVICE_SCOPES),
  M03 (port-8015 collision), M13 (helm 11 missing services), M14
  (conditions-normalizer compose entry), M15 (workflow-engine + queue-
  worker compose entries — verify against current state per OQ-1
  below), M39 (`inchikey_from_smiles` registration), M49 (LiteLLM
  proxy), M50 (kg-source-cache depends_on), M118 (compose healthcheck
  doc).
- **Files**: `services/workflow_engine/main.py`,
  `services/agent-claw/src/security/mcp-token-cache.ts`,
  `services/mcp_tools/common/scopes.py`, `docker-compose.yml`,
  `services/mcp_tools/mcp_genchem/{Dockerfile,main.py}`,
  `infra/helm/templates/chemistry-deployments.yaml`,
  `infra/helm/values.yaml`, `services/agent-claw/src/bootstrap/dependencies.ts`,
  `skills/library_design_planner/SKILL.md`,
  `skills/qm_pipeline_planner/SKILL.md`.
- **Effort**: M.
- **Verification**: `docker compose --profile chemistry,sources,testbed,observability up -d`
  → all containers `Up` within 60 s; agent calls `score_green_chemistry`
  / `assess_applicability_domain` and gets a 200/4xx (not McpAuthError);
  `helm template infra/helm | grep -c "kind: Deployment"` equals the
  number of compose chemistry-profile services.
- **Risk**: choosing the new genchem port (8022 or 8023) must match
  agent-claw `config.ts` default. If `inchikey_from_smiles` is just
  removed from the two skills instead of registered, the skills'
  workflow-builder prompts must be re-tested.
- **Tests to add**: scope-pact test (R01 F-01); compose port-uniqueness
  test; helm-vs-compose service-set diff test.

### 2. RLS-HARDENING — *close cross-tenant data leak*

- **Goal**: every project-scoped + user-derived table FORCE RLS; audit
  log can grow indefinitely; `kg-hypotheses` ack key matches convention.
- **Includes**: M04 (workflow tables), M05 (queue/screen/genchem),
  M06 (qm_*), M07 (user_project_access), M18 (audit partition daemon),
  M41 (kg-hypotheses hyphen ack), M42 (5 missing search_path),
  M43 (audit triggers on hypotheses/artifacts/reactions/...),
  M44 (delete stale `db/migrations/202604230001_*`), M61 (`tools` /
  `mcp_tools` catalog RLS), M124 (legacy 01_schema permissive policies).
- **Files**: `db/init/{01,12,17,19,23,25,26,27,28,29}_*.sql`;
  `services/agent-claw/src/core/workflows/client.ts` (switch
  `withSystemContext` → `withUserContext` for user-scoped reads);
  `services/projectors/kg_hypotheses/main.py:30`;
  `services/optimizer/audit_partition_maintainer/` (NEW); migration to
  rename `projection_acks.projector_name='kg-hypotheses'` →
  `'kg_hypotheses'`.
- **Effort**: L.
- **Verification**: integration test: insert workflow_run as user A,
  attempt SELECT as user B in `withUserContext` → 0 rows. pgTAP-style:
  `SELECT count(*) FROM pg_policies WHERE tablename = 'workflow_runs'`
  ≥ 2. `make db.init && make db.init` idempotent.
- **Risk**: switching `client.ts` from `withSystemContext` to
  `withUserContext` alters EXISTS subquery semantics; manually verify
  every project-scoped policy still functions.
- **Tests to add**: real-Postgres testcontainer test for each newly-
  RLS'd table; pgTAP `policies_are` checks.

### 3. EVENT-SOURCING-CORRECTNESS — *the bus actually carries traffic*

- **Goal**: every projector fires; events emit on workflow completion;
  source-cache hook stops dead-lettering; queue retries with backoff.
- **Includes**: M08 (`experiment_imported` live emitter), M09
  (kg_source_cache UUID-cast bug), M35 (workflow step-failed for
  unimplemented kinds), M36 (`_sweep` FOR UPDATE SKIP LOCKED), M37
  (workflow_run_succeeded ingestion_event emit), M47 (queue retry
  backoff), M92 (qm_kg synthetic-event channel pollution), M96
  (real JMESPath or rename), M97 (`_exec_wait` connection reuse),
  M123 (idempotency_key shape).
- **Files**: `services/agent-claw/src/core/hooks/source-cache.ts:370-378`;
  `services/projectors/qm_kg/main.py:240-245`;
  `services/workflow_engine/main.py`;
  `services/queue/worker.py`;
  `services/ingestion/eln_json_importer.legacy/{cli.py,importer.py}`
  (decision per OQ-2);
  `db/init/27_job_queue.sql`;
  `services/agent-claw/src/core/workflows/types.ts`.
- **Effort**: M.
- **Verification**: integration test that emits a `source_fact_observed`
  via the actual hook → `kg_source_cache` projector ack appears within
  10 s. Workflow definition with a `conditional` step → run
  status='failed' (not 'succeeded' with a no-op note).
- **Risk**: deciding emitter shape for `experiment_imported` needs
  coordination with the ELN/SDMS team — see OQ-2.
- **Tests to add**: real-Postgres source-cache loop test (single
  highest-leverage test in the entire backlog per R11); workflow
  unimplemented-kind step_failed test.

### 4. AUTH-EVERYWHERE — *every MCP-to-MCP path has a Bearer token*

- **Goal**: no service is reachable without a valid scoped JWT in any
  prod-shaped deploy; admin auth surfaces unified.
- **Includes**: M10 (eln-local + logs-sciy MCP_AUTH_SIGNING_KEY env),
  M11 (yield-baseline → drfp/chemprop tokens), M17 (TS/Py token cache
  fail-mode parity), M23 (`expectedAudience` on `/api/internal/*`),
  M85 (mcp_tabicl admin token retire).
- **Files**: `docker-compose.yml`;
  `services/mcp_tools/mcp_yield_baseline/main.py`;
  `services/mcp_tools/common/mcp_token_cache.py`;
  `services/agent-claw/src/routes/sessions-handlers.ts:375`;
  `services/agent-claw/src/security/mcp-tokens.ts`;
  `services/optimizer/session_reanimator/main.py`;
  `services/mcp_tools/mcp_tabicl/main.py:160-174`.
- **Effort**: M.
- **Verification**: with `MCP_AUTH_SIGNING_KEY` set in `.env`, agent
  calls every documented MCP builtin → 200/4xx, not 401. Reanimator
  POST to `/api/internal/sessions/:id/resume` only succeeds with
  `aud=agent-claw`.
- **Risk**: the TS-Py fail-mode unification (M17) is a behaviour change
  for the Python side — operators relying on the silent-warn need a
  release-note callout.
- **Tests to add**: pact test that TS and Py SERVICE_SCOPES + fail-mode
  match; integration test that JWT without correct `aud` is rejected.

### 5. PERMISSIONS-ENFORCE-EVERYWHERE — *deny rules actually deny*

- **Goal**: every harness call site honours `permission_policies`;
  admin auth uses the canonical `admin_roles` path; admin mutations
  emit audit rows.
- **Includes**: M16 (resolver on 7 surfaces), M34 (4 admin routes
  use legacy `requireAdmin` + bypass `appendAudit`), M40 (resolver
  `ask` decision wired or downgraded explicitly), M74 (hook YAML
  documentation + stale comments in `core/types.ts` and
  `core/permissions/resolver.ts`), M77 (sub-agent recursion guard +
  permission inheritance).
- **Files**: `services/agent-claw/src/routes/{chat-non-streaming.ts,
  plan.ts, deep-research.ts, sessions-handlers.ts}`;
  `services/agent-claw/src/core/{harness.ts, chained-harness.ts,
  sub-agent.ts, step.ts, permissions/resolver.ts, types.ts}`;
  `services/agent-claw/src/routes/{eval.ts, optimizer.ts, skills.ts,
  forged-tools.ts}`; `services/agent-claw/src/middleware/require-admin.ts`;
  `hooks/permission.yaml`.
- **Effort**: M.
- **Verification**: insert a `permission_policies` row with
  `decision='deny' tool_pattern='canonicalize_smiles'`; POST to each
  harness-invoking route; assert all 7 surfaces refuse the tool call.
  `appendAudit` rows in `admin_audit_log` for each `/api/forged-tools/*`,
  `/api/skills/*`, `/api/eval`, `/api/optimizer/*` mutation.
- **Risk**: ADMIN-1 is a semantic change — operators who granted role
  via `user_project_access.role='admin'` need migration to `admin_roles`.
- **Tests to add**: per-route permission-deny test; per-admin-route
  audit-row test.

### 6. OBSERVABILITY-EVERYWHERE — *operators can actually see what's wrong*

- **Goal**: every harness call path emits a Langfuse root span with
  prompt-tag; structured logging on every long-running service;
  err.message scrubbed of SMILES; `error_events` is written; Grafana
  dashboards show data.
- **Includes**: M24 (Pino content-aware redactor), M25 (Python
  `exc_info`/`exc_text` redaction), M30 (`record_error_event` callers),
  M31 (Langfuse roots on 6 paths), M32 (configure_logging on 6
  services), M33 (Grafana label fix), M52 (DR un-redacted SSE
  question), M76 (`tag-maturity` swallow), M99 (Pino redact additions),
  M100 (CLAUDE.md ↔ logger.ts doc fix).
- **Files**: `services/agent-claw/src/observability/logger.ts`;
  `services/mcp_tools/common/redaction_filter.py`;
  `services/agent-claw/src/routes/{plan,deep-research,sessions-handlers}.ts`;
  `services/agent-claw/src/core/{chained-harness,sub-agent}.ts`;
  `services/projectors/kg_hypotheses/main.py:167`;
  `services/projectors/kg_source_cache/main.py`;
  `services/optimizer/{session_purger,session_reanimator,gepa_runner,
  skill_promoter,forged_tool_validator}/runner.py`;
  `infra/grafana/provisioning/dashboards/projectors.json`;
  `infra/promtail/promtail-config.yaml`;
  `services/agent-claw/src/routes/deep-research.ts:213` (sink override).
- **Effort**: L.
- **Verification**: a 200 KB Postgres error log line in agent-claw
  reaches Loki without any `CMP-` / `NCE-` literal. Langfuse trace
  appears for every harness invocation. Grafana projectors dashboard
  shows non-zero panels for at least `chunk-embedder` and
  `reaction-vectorizer`.
- **Risk**: content-aware Pino formatter is the largest single piece
  (~150 LOC + tests); ensure no perf regression in the log hot path.
- **Tests to add**: redactor unit tests over `err.message`; a CI doc-
  consistency check (sketched in R13) that catches CLAUDE.md ↔ code
  drift; Grafana dashboard query smoke test.

### 7. SERVICE-REGISTRY — *kill the merge-debt bug class*

- **Goal**: one row per MCP service drives `SERVICE_SCOPES` (TS+Py),
  `config.ts` URL defaults, helm values, and `.env.example` entries.
- **Includes**: M02, M13, M57 (the registry itself), and indirectly
  closes M111 (env var sprawl) for MCP URLs.
- **Files**: `services/agent-claw/src/config/services.ts` (NEW);
  `services/agent-claw/src/security/mcp-token-cache.ts`;
  `services/mcp_tools/common/scopes.py` (autogenerated, banner);
  `services/agent-claw/src/config.ts`;
  `infra/helm/values.yaml` (autogenerated chemistry/sources/testbed
  sub-trees); `.env.example` (autogenerated MCP URL block);
  `Makefile` (codegen target);
  `tests/integration/test_service_registry_pact.py` (NEW);
  `scripts/codegen-services.ts` (NEW).
- **Effort**: L.
- **Verification**: pact test `test_service_registry_pact` passes —
  every MCP_SERVICES row appears in compose, helm, scopes.py,
  .env.example with correct port and (where required) auth env.
  `make codegen && git diff --exit-code` clean.
- **Risk**: codegen complexity. Mitigate by committing generated files
  and running codegen on `make precommit`.
- **Tests to add**: the pact test is the deliverable.

### 8. TEST-INTEGRITY — *real DB at the hot path*

- **Goal**: every Wave-1 P0 has a corresponding integration test;
  CI cannot quietly skip the integration trio; `tests/unit/` runs in
  full.
- **Includes**: M12 (re-include test_mcp_doc_fetcher.py + tabicl in
  CI; fix the rename to `ip_is_blocked`), M48 (real-Postgres tests for
  source-cache → kg_source_cache loop, `_advance_run`, `_lease_one`),
  M78 (workflow engine tests), M79 (queue worker tests), M80 (golden
  set runner — placeholder content can stay until Z7 substantively
  curates it; the *runner* is the missing piece), M81 (diff-cover on
  push), M82 (`make test` segfault — split target), M90 (4 zero-test
  services), M121 (CI Docker explicit declaration).
- **Files**: `.github/workflows/ci.yml`;
  `tests/unit/test_mcp_doc_fetcher.py`;
  `services/workflow_engine/tests/`;
  `services/queue/tests/`;
  `services/projectors/kg_source_cache/tests/`;
  `services/mcp_tools/{mcp_drfp,mcp_embedder,mcp_kg,mcp_rdkit}/tests/`
  (NEW); `services/optimizer/scripts/run_golden_set.py` (NEW); Makefile
  (split mcp test target).
- **Effort**: L.
- **Verification**: `pytest tests/unit -q` passes (currently 11
  failures + 3 collect errors); CI runs the integration trio with an
  explicit `services:` declaration; every Wave-1 P0 ID has a test in
  the suite that would have caught it pre-merge.
- **Risk**: test additions don't fix the underlying defects — must
  pair with clusters 1/2/3.

### 9. CONFIG-PROVE-OUT — *prove the config infra wires through end-to-end*

- **Goal**: at least one `config_settings` key is read by Python code,
  at least one `feature_flags` row gates real behaviour, the `PYTEST_
  CURRENT_TEST` salt carve-out is gone, the `MCP_AUTH_REQUIRED` env
  fallback is deprecated.
- **Includes**: M29 (`PYTEST_CURRENT_TEST` carve-out), M38 (skill
  loader honours `maturity` + `shadow_until`), M53 (Python
  ConfigRegistry first consumer — `optimizer.promotion_success_rate`),
  M54 (one feature flag actually gates code; suggest `mock_eln.enabled`
  → mcp-eln-local lifespan reads it instead of pydantic env), M55
  (NOTIFY-driven redaction-pattern invalidation OR documented 60 s
  delay in admin response), M56 (DSN naming consolidation), M83/M84
  (timeout + optimizer constants migration), M111 (`.env.example`
  refresh), M117 (`process.env` audit — promote AGENT_SHADOW_SAMPLE,
  DB_SLOW_TXN_MS, sandbox caps to Config).
- **Files**: `services/mcp_tools/common/user_hash.py:42-46`;
  `services/agent-claw/src/core/skills.ts:331-391`;
  `services/optimizer/skill_promoter/promoter.py:33-35, 254-256`;
  `services/common/config_registry.py` (add cache invalidation NOTIFY);
  `services/litellm_redactor/dynamic_patterns.py`;
  `services/mcp_tools/mcp_eln_local/main.py` (read flag instead of env);
  `services/agent-claw/src/config.ts` (move scattered env reads in);
  `.env.example`.
- **Effort**: M.
- **Verification**: `agent.max_active_skills` AND
  `optimizer.promotion_success_rate` both read by code; flipping
  `mock_eln.enabled` in the DB takes effect after the gateway's 60 s
  TTL; no Python service references `PYTEST_CURRENT_TEST`.
- **Risk**: removing `PYTEST_CURRENT_TEST` requires every test
  conftest to set `CHEMCLAW_DEV_MODE=true` — verify suite still passes.

### 10. SECURITY-HARDENING — *defense-in-depth for what already works*

- **Goal**: ReDoS-safe DB CHECKs, DNS-rebinding pinned IP, sandbox
  prod-guard, forge_tool name allowlist, LiteLLM digest-pinned image,
  CVE bumps.
- **Includes**: M22 (DB CHECK + `is_pattern_safe` nested-quantifier),
  M26 (DNS-rebinding TOCTOU), M27 (LocalSubprocessSandbox prod guard),
  M28 (forge_tool name allowlist), M46 (LiteLLM digest pin), M86/M87
  (redaction double-fire / tenant-prefixes), M130 (CORS null origin),
  M131 (header-trust documentation), M136 (CVE bumps).
- **Files**: `db/init/20_redaction_patterns.sql`;
  `services/litellm_redactor/dynamic_patterns.py`;
  `services/mcp_tools/mcp_doc_fetcher/{validators.py,fetchers.py}`;
  `services/optimizer/forged_tool_validator/sandbox_client.py`;
  `services/agent-claw/src/tools/builtins/forge_tool.ts`;
  `services/litellm_redactor/Dockerfile`;
  `services/agent-claw/src/bootstrap/server.ts`;
  per-service `requirements.txt` (CVE bumps).
- **Effort**: M.
- **Verification**: a `pattern_regex='(a+)+$'` admin POST returns 400;
  an SSRF redirect to a metadata-IP after rebinding the host fails;
  `LocalSubprocessSandbox` import in prod raises; `forge_tool` rejects
  `name="../../etc/passwd"`.

### 11. DOC-TRUTH — *CLAUDE.md, ADRs, runbooks match code*

- **Goal**: contributors reading CLAUDE.md, ADR 001/006/010, and the
  runbooks see the actual current state.
- **Includes**: M100, M101, M102, M103, M104, M105, M106, M107, M108,
  M109, M110, M135.
- **Files**: `CLAUDE.md`; `AGENTS.md`; `docs/adr/{001,006,010}-*.md`;
  `docs/runbooks/{rotate-mcp-auth-key,autonomy-upgrade,backup-and-
  restore,redaction-pattern-management,harness-rollback,local-dev}.md`;
  `services/frontend/` (delete or document); plus `prompt.md` for the
  13 new skills (low-priority, can wait).
- **Effort**: S.
- **Verification**: a doc-consistency CI check (R13 sketch) compares
  CLAUDE.md Phase F service list to docker-compose.yml ports; runs
  green after this cluster.

### 12. TS-MAINTAINABILITY (catch-all P2/P3)

- **Goal**: dedup, unused exports gone, drain timeout, tsconfig flags.
- **Includes**: M67 (envelope sweep), M68/M69/M70/M71/M72/M93/M94
  (dedup + dead exports), M73 (probe loop initial run), M75 (session_
  end stub), M83 (timeout constants if not in config-prove-out), M95
  (MIN_EXPECTED_HOOKS relocation), M98 (DR ↔ chat dedup), M112
  (sandbox env duplicate), M116 (checkStaleFacts dead branch), M117
  (process.env scattering), M119 (drain timeout), M120 (tsconfig flags),
  M132 (unrecognised hook YAML fields), M128/M129 (TS nice-to-haves),
  M133 (compactor fallback).
- **Files**: many under `services/agent-claw/src/`.
- **Effort**: M (split into 2-3 PRs).
- **Verification**: `npx ts-prune` returns the expected delta; `tsc
  --noEmit` clean with new flags; `npm test` passes.

### 13. MCP-PYTHON-CORRECTNESS

- **Goal**: heavy work moved to `to_thread` / async client; expensive
  resources held in lifespan; `mol_from_smiles` shared helper lands.
- **Includes**: M19 (11 services blocking the loop), M20 (per-request
  resource reload), M21 (qm_kg sync neo4j), M51 (chemprop SMILES
  validation), M88 (`common/chemistry.py:mol_from_smiles`),
  M89 (`_constraints.txt` adoption across all services), M91 (projector
  connection reuse), M113 (xtb conformer_ensemble version flag),
  M114 (xtb `_helpers` ↔ `_shared` dedup), M122 (yield_baseline
  global-model load guard), M134 (dead imports).
- **Files**: 15+ MCP service `main.py` files; new
  `services/mcp_tools/common/chemistry.py`; per-service
  `requirements.txt` adding `-c ../../_constraints.txt`.
- **Effort**: L.
- **Verification**: under load test (10 concurrent requests), `/healthz`
  on each MCP responds within 1 s; first-call cold-start of
  `mcp_chemprop` does not block. Every MCP service's `requirements.txt`
  contains the constraints reference.

---

## Recommended PR sequence

The listed order is the proposed merge order. Cluster 1 must land
first because nothing else can be smoke-tested without a working compose
stack. Cluster 7 is intentionally placed in Wave B (not Wave A) because
the codegen + pact-test work is too big to inline with the urgent
runtime fix; instead, Cluster 1 hand-fixes the worst of the merge-debt
and Cluster 7 *removes the bug class* afterwards.

### Wave A — this week (P0)

1. **CRITICAL-RUNTIME** — unblocks every other cluster and integration
   test. Without M01 (workflow_engine SQL) the whole workflow surface
   stays broken.
2. **RLS-HARDENING** — multi-tenant data leak is the single highest
   security severity in the review. Lands second because it requires a
   stable compose to test against.
3. **EVENT-SOURCING-CORRECTNESS** — once RLS lands, the
   `kg_source_cache` UUID fix and the `experiment_imported` emitter
   restore the projector pipeline. Workflow engine concurrency + step-
   failed semantics ride on the same PR.
4. **AUTH-EVERYWHERE** — completes the production-startable picture so
   every documented MCP can authenticate; should land before any
   security-hardening cluster touches the same auth code.

### Wave B — next week (P1)

5. **PERMISSIONS-ENFORCE-EVERYWHERE** — the highest defense-in-depth
   gap. Pair the resolver-on-every-route patch with the canonical
   `guardAdmin` migration and the audit-row sweep so admin RBAC is
   uniform.
6. **OBSERVABILITY-EVERYWHERE** — dashboards and Pino redactor matter
   most after the security boundary is back in place; operators need to
   see what's happening before they tune anything.
7. **SERVICE-REGISTRY** — eliminate the merge-debt bug class. Sized as
   ~+120 LOC net but touches generated files in 4 languages.
8. **TEST-INTEGRITY** — close the integration-test gap that allowed
   M01/M09 to merge. Land after observability so the new tests inherit
   structured logs / Langfuse spans.

### Wave C — following week (P2/P3)

9. **CONFIG-PROVE-OUT** — wire one Python config_setting consumer, one
   feature_flag gate, retire `PYTEST_CURRENT_TEST`, refresh `.env.example`.
10. **SECURITY-HARDENING** — ReDoS DB CHECK, DNS-pin, sandbox guard,
    forge_tool allowlist, LiteLLM digest, CVE bumps.
11. **DOC-TRUTH** — bring CLAUDE.md / ADRs / runbooks into agreement
    with code; pair with the doc-consistency CI check from R13.
12. **TS-MAINTAINABILITY** + **MCP-PYTHON-CORRECTNESS** — final pair,
    largest absolute LOC churn, lowest external risk.

---

## Out-of-scope items (declassified or deferred)

The following findings were called HIGH / P0 in their source report but
have been re-graded down per the rubric:

- **R02 P1-10 (confidence model)** kept at P1 — it does not silently
  break a path today. Authors of any new code that writes to
  `reactions.confidence_*` must update both columns; deferred to
  DB-MAINTAINABILITY (in TS-MAINTAINABILITY's tail end).
- **R06 HIGH-1 (`/conformer_ensemble` numerical change, M113)**
  re-graded from HIGH to P2: route shape is unchanged, output magnitude
  shifted but is *more correct* (uses real RT(298 K)). Add a
  `method_version: "v2"` field rather than gate the rollout.
- **R02 P3-19 (error_events retention)** stays P3 — operator concern, not
  correctness; partition or document in DOC-TRUTH.
- **R04 F-13 (Python CVE bumps in optimizer venv)** stays P3 — none of
  these affect a user-facing path today; dev/optimizer venv only.
- **R10 F-11 (vendored `mcp_synthegy_mech` print() calls)** declassified
  to no-op: vendored code from upstream `schwallergroup/steer`, MIT,
  carry-upstream policy — the upstream project is the right place to
  fix; not a chemclaw concern.
- **R12 F-12.13 (compactor Haiku-fallback)** kept at P3 — adds a
  fallback truncate; cosmetic until LLM provider outage is observed.
- **R13 D3 items** (Streamlit UI residual references in AGENTS.md;
  prompt.md missing for 13 new skills; ADR 005 missing new tables) all
  rolled into DOC-TRUTH but at the tail.
- **R11 §"Flaky-Test Inventory"** declassified: ceilings are generous;
  not blocking. No action required.
- **R02 P3-22 (`task_queue.idempotency_key` shape)** rolled into
  EVENT-SOURCING-CORRECTNESS as M123 P2 — document or coerce; either
  works.
- **R05 SHUTDOWN-1, TSCONFIG-1, CONNECTION-1, TYPES-1/2/3** — all P3
  cleanup-shaped, in TS-MAINTAINABILITY tail.

---

## Open Questions for the User

Five product / architecture decisions are needed before the backlog
runs cleanly. None block Wave A but each saves a downstream PR.

1. **Are `workflow-engine` + `queue-worker` compose entries currently
   present?** R03 lists them under the `chemistry` profile (lines
   327-381 of compose); R08 says "no docker-compose entries for either
   service." Cross-reading suggests they were added in commit
   `c72dd92`. Confirm: `grep -n "workflow-engine:\|queue-worker:"
   docker-compose.yml`. Either way, M14 (conditions-normalizer) and
   M50 (kg-source-cache depends_on) are real.
2. **Should `experiment_imported` events come from a NEW emitter
   inside `mcp_eln_local`, OR by translating `source_fact_observed`
   events with a small adapter projector, OR by reviving (fixing) the
   legacy ELN JSON importer?** R02 / R07 lay out three options. The
   cheapest fix is the projector adapter; the cleanest is a live
   emitter. The mock-ELN testbed seeder needs a way to fire too.
3. **Is the Phase E shadow-serving feature actually wanted, or should
   the backlog instead remove `skill_library.shadow_until` from the
   schema?** R12 F-12.2 — the column exists; nothing reads it. If
   shadow-serving is part of v1.0 promise, fix the loader. If it is
   deferred, drop the column.
4. **Is the legacy `services/ingestion/eln_json_importer.legacy/`
   package needed for one-shot bulk migrations, or should it be
   deleted?** R07 F.2 — its imports are broken; CLAUDE.md flags it
   "preserved for migrations." If preserved, fix the import paths
   (4-line change). If dead, delete the directory + Makefile target.
5. **Is `services/frontend/` actually moved to a separate repo, or
   does it still live here?** R03 F11, R13 D0. The directory still
   has `__pycache__/` and `pages/`. Decide: delete the stub + commit a
   dead-link note, or restore the Streamlit code to v1.0 status. The
   doc claim and the on-disk reality must agree.

---

End of synthesis. Master table contains 136 items renormalised across
all 13 specialist reports.
