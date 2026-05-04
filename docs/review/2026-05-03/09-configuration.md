# Configuration Coherence Audit — 2026-05-03

Read-only audit of the configuration surface across `main`. The driving question
is whether the recurring SERVICE_SCOPES / compose / helm / config.ts / .env
omissions surfaced in Wave 1 (`01-merge-integrity.md` F-01, F-05;
`03-architecture.md` Findings 1–6, 9; `04-security.md` F-3) are isolated bugs
or a systemic absence of a service registry. Conclusion up front: it is a
systemic absence, and the fix is concrete and small enough to land without a
multi-week refactor — see §5.

Severity legend (config audit):
- **C0** — every new MCP service ships broken in production by default
- **C1** — config-source drift that silently degrades a tenant or admin path
- **C2** — naming, redaction-cache, or env hygiene issues that bite operators
- **C3** — cleanup / doc drift

---

## Executive Summary

| Severity | Finding | File:line | Fix sketch |
|---|---|---|---|
| **C0** | Adding a new MCP service requires editing **six** independent files (compose ports, compose `MCP_AUTH_SIGNING_KEY` env, `services/agent-claw/src/config.ts` URL default, `services/agent-claw/src/security/mcp-token-cache.ts` SERVICE_SCOPES, `services/mcp_tools/common/scopes.py` SERVICE_SCOPES, `infra/helm/values.yaml` + `chemistry-deployments.yaml`, `.env.example`). No registry; humans coordinate by hand. **Wave 1 confirms ~25% of new MCPs landed with at least one of these omitted.** | docker-compose.yml; services/agent-claw/src/config.ts; services/agent-claw/src/security/mcp-token-cache.ts:26-47; services/mcp_tools/common/scopes.py:20-41; infra/helm/values.yaml:92-138 | Land `services/agent-claw/src/config/services.ts` (single source of truth); derive SERVICE_SCOPES, config.ts URL defaults, and a generated `.env.example` snippet from it. See §5 for the full sketch (~120 LOC added, ~80 LOC removed across two map sites; 1 service ⇒ 1 row). |
| **C1** | Python `ConfigRegistry` exists at `services/common/config_registry.py` but is **not consumed by any Python service** in the tree (only docs / `__init__.py` reference it). Every Python service still pulls from `os.environ` directly with hardcoded defaults; the table-backed concept lands TS-side only. | services/common/config_registry.py vs. all 22 mcp_tools services; services/optimizer/skill_promoter/promoter.py:33-35 (PROMOTION_SUCCESS_RATE = 0.55 etc., hardcoded despite being explicitly cited in CLAUDE.md as the example use-case) | Either delete the Python module (and document that config-registry is TS-only) or wire it in: skill_promoter / gepa_runner / forged_tool_validator are the obvious first consumers. |
| **C1** | `isFeatureEnabled` is exported from `config/flags.ts` and described prominently in CLAUDE.md, but **the only consumers are the admin GET/POST routes themselves** (no production code path checks a flag). Every flag-shaped gate still runs through `process.env.X === "true"` — `chemclaw_dev_mode`, `mock_eln.enabled`, `mcp.auth_dev_mode`, `agent.confidence_cross_model` all have DB rows that nothing reads. | `grep -rn 'isFeatureEnabled' services/agent-claw/src` → only flags.ts + admin-flags.ts; CLAUDE.md:243 example usage `if (await isFeatureEnabled("agent.confidence_cross_model", ...))` does NOT exist anywhere in code | Either delete the seeded DB rows + the registry as misleading, or migrate at least one real call site to prove the flow end-to-end. The seeded rows mislead admins — they think a toggle works, but it can't take effect. |
| **C1** | The redaction-pattern admin route (`admin-redaction.ts`) does NOT call `.invalidate()` on any cache after writes — and it can't, because the loader cache lives in a separate process (the LiteLLM gateway). Admin sees their PATCH succeed but the new pattern doesn't take effect for ≤ 60 s, with no signal. | services/agent-claw/src/routes/admin/admin-redaction.ts:120-200 (no invalidate calls) vs. admin-config.ts:178,239 / admin-flags.ts:121,157 / admin-permissions.ts:143,193,233 (all do call invalidate) | Document the cross-process gap in the route response (`{ ok: true, propagation_delay_seconds: 60 }`), OR add a Postgres NOTIFY channel `redaction_patterns_changed` that the gateway's loader subscribes to. The latter is ~30 LOC and matches the existing `ingestion_events` LISTEN/NOTIFY pattern. |
| **C1** | Three concurrent DSN-shaped env vars exist (`POSTGRES_DSN`, `REDACTOR_PG_DSN`, `CHEMCLAW_SERVICE_DSN`) **plus** the multi-component `POSTGRES_HOST`/`POSTGRES_PORT`/...; some services accept the DSN form, most rebuild the DSN from components. None of the three composite vars is in `.env.example`. | services/mcp_tools/mcp_genchem/main.py:67,70-74; services/litellm_redactor/dynamic_patterns.py:72; services/mcp_tools/mcp_yield_baseline/scripts/build_global_xgb.py:68; services/mcp_tools/common/qm_cache_db.py:56-62; .env.example (none of the three DSN names documented) | Pick one. The `*_DSN` form is more flexible (URI-style, optional sslmode); decompose it inside each service via `psycopg.conninfo.conninfo_to_dict`. Then delete the multi-component env vars from every service. |
| **C1** | Python user_hash dev-mode test silently accepts `PYTEST_CURRENT_TEST` as a dev signal — same finding as `04-security.md` F-6. Cross-checked here because it crosses the config-source boundary: env (`CHEMCLAW_DEV_MODE`) ↔ test runner (`PYTEST_CURRENT_TEST`) ↔ feature_flag (`chemclaw.dev_mode`, seeded but unread). **Three sources of truth disagree.** | services/mcp_tools/common/user_hash.py:42-46 | Drop the `PYTEST_CURRENT_TEST` clause; require explicit `CHEMCLAW_DEV_MODE=true` only (matches the TS mirror at `services/agent-claw/src/observability/user-hash.ts:45`). Pytest fixtures already set the explicit form. |
| **C2** | Naming inconsistency between `feature_flags.key` (lowercase, dotted, e.g. `mock_eln.enabled`) and `config_settings.key` (also lowercase dotted, e.g. `agent.max_active_skills`) and the env-var fallback (`MOCK_ELN_ENABLED`, `AGENT_MAX_ACTIVE_SKILLS`) — the conversion is `flags.ts:envFallback` doing `key.toUpperCase().replace(/\./g, "_")`. **No documented inverse for config_settings.** A new admin sees `agent.max_active_skills` and has to grep code to learn the env-var fallback shape. | services/agent-claw/src/config/flags.ts:110-114 (only `feature_flags` has the convention encoded); config_settings has none | Either document the convention as a CLAUDE.md addendum, or add a parallel `config/registry.ts:envFallback` so callers can pass a default that's read via the same convention from env. Today they pass a hardcoded number / string. |
| **C2** | 21+ hardcoded timeout constants in `services/agent-claw/src/tools/builtins/*.ts` (`TIMEOUT_KG_MS = 15_000`, `TIMEOUT_ASKCOS_MS = 30_000`, etc.) — none consume `config_settings`. CLAUDE.md says "When a new constant is born hardcoded, file a follow-up PR to migrate it"; nobody has. | `grep -rEn 'TIMEOUT_[A-Z_]+_MS\s*=' services/agent-claw/src/tools/builtins/` → 21 files, 0 of them consume the registry | Pick the 3-5 that operators actually want to tune (askcos, aizynth, chemprop are the slow ones) and migrate. The rest are fine as constants. |
| **C2** | Optimizer / skill-promoter constants explicitly enumerated in CLAUDE.md as the canonical example (`PROMOTION_SUCCESS_RATE = 0.55`, `MIN_RUNS = 30`, etc.) are still hardcoded. CLAUDE.md says `reg.get_float("optimizer.promotion_success_rate", default=0.55)`. | services/optimizer/skill_promoter/promoter.py:33-35; services/optimizer/skill_promoter/promoter.py:254-256; services/optimizer/gepa_runner/metric.py:24-26; services/optimizer/gepa_runner/examples.py:19 | Migrate. This is the example used to motivate the registry; if it's not migrated by now, the registry's value isn't visible. |
| **C2** | `services/mcp_tools/mcp_tabicl/main.py:160-174` ships a parallel admin-auth surface (`MCP_TABICL_ADMIN_TOKEN` env + `x-admin-token` header) instead of using the unified JWT scope mechanism. Same finding as `06-mcp-python.md` MED-10; raised again here because it's a config-system divergence. | services/mcp_tools/mcp_tabicl/main.py:160-174 | Retire the env-var token; gate `/pca_refit` on a `mcp_tabicl:admin` JWT scope. |
| **C2** | `redaction_patterns` table seeds the EXISTING hardcoded patterns as global rows (good), but `redaction.py` ALSO continues to apply the hardcoded patterns. So every `SMILES`/`RXN_SMILES`/`EMAIL`/`NCE`/`CMP` pattern fires twice on every prompt — once from compiled-in code, once from the DB row. Disabling the DB row has no effect. | services/litellm_redactor/redaction.py:127-132 (compiled-in always run) + services/litellm_redactor/dynamic_patterns.py + db/init/20_redaction_patterns.sql:63-91 (5 global seed rows duplicating the compiled-in patterns) | Either skip seeded rows whose category matches a compiled-in pattern, or drop the seed rows entirely (their stated purpose — "admins can SEE them in /api/admin/redaction-patterns" — is fulfilled, but the side-effect of double-redaction is confusing). |
| **C2** | `.env.example` lines 159-161 reference vendor source-system MCPs that no longer exist (`MCP_ELN_BENCHLING_URL=8013`, `MCP_LIMS_STARLIMS_URL=8014`, `MCP_INSTRUMENT_WATERS_URL=8015`). Code reads `MCP_ELN_LOCAL_URL` (8013), `MCP_CREST_URL` (8014), `MCP_YIELD_BASELINE_URL` (8015) — same ports, different names. Already in `03-architecture.md` Finding 9. | .env.example:159-161 | Delete those three lines; add the actually-consumed names (already enumerated in `03-architecture.md`). |
| **C3** | 36 env vars referenced by code are NOT in `.env.example`: `AIZYNTH_CONFIG`, `ASKCOS_MODEL_DIR`, `CHEMBENCH_DATASET_PATH`, `CHEMCLAW_SERVICE_DSN`, `CHEMPROP_MODEL_DIR`, `DB_SLOW_TXN_MS`, `DOYLE_DATASET_PATH`, `GEPA_MODEL`, `GEPA_PORT`, `LITELLM_API_KEY`, `LITELLM_BASE_URL`, `LITELLM_PLANNER_MODEL`, `LITELLM_REDACTION_LOG_SAMPLE`, `LOG_ACCESS_PROBES`, `LOG_FORMAT`, `LOG_LEVEL` (top-level), `MCP_CREST_URL`, `MCP_DOC_FETCHER_FILE_ROOTS`, `MCP_GENCHEM_URL`, `MCP_TABICL_PCA_PATH`, `MCP_XTB_BASE_URL`, `MCP_XTB_STEP_TIMEOUT_SECONDS`, `MCP_XTB_WORKFLOW_TIMEOUT_SECONDS`, `MCP_YIELD_BASELINE_URL`, `MCP_APPLICABILITY_DOMAIN_URL`, `MCP_GREEN_CHEMISTRY_URL`, `MCP_PLATE_DESIGNER_URL`, `MCP_ORD_IO_URL`, `MCP_REACTION_OPTIMIZER_URL`, `MCP_LOGS_SCIY_URL`, `MCP_ELN_LOCAL_URL`, `MCP_SYNTHEGY_MECH_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `POSTGRES_DSN`, `REDACTOR_PG_DSN`, `SANDBOX_MAX_CPU_S`, `SANDBOX_MAX_NET_EGRESS`, `SKILL_PROMOTER_PORT`, `WORLD_SEED`, `MCP_TABICL_ADMIN_TOKEN`, `MOCK_ELN_ALLOW_DEV_PASSWORD`, `LOGS_ALLOW_DEV_PASSWORD`. Same finding as `01-merge-integrity.md` F-13, more complete here. | .env.example | Add each with a sensible dev default + comment; group by service. The `services.ts` registry sketched in §5 can render these automatically. |

Net new severity counts: 1 C0, 6 C1, 5 C2, 1 C3.

---

## 1. Configuration-Source Inventory

### 1A. `config_settings` rows (Postgres)

The table ships **empty by default**. The migration `db/init/19_config_settings.sql:117` ends in `COMMIT;` with no INSERT seed block. The seeds enumerated in CLAUDE.md ("MAX_ACTIVE_SKILLS, GEPA promotion thresholds, reanimator stalled-definition knobs, per-role inference params, default per-tenant budgets") DO NOT EXIST as DB rows. Operators discover knob keys only by reading code — there is no `GET /api/admin/config?key_prefix=` populated catalog.

| Key | Defined by code | Default | Type | Resolved at |
|---|---|---|---|---|
| `agent.max_active_skills` | services/agent-claw/src/core/skills.ts:72 | `8` | number | per-turn |
| (none other) | — | — | — | — |

**Single key** in production code consumes `config_settings`. Every other tunable is hardcoded.

### 1B. `feature_flags` rows (Postgres)

Seeded at `db/init/22_feature_flags.sql:62-80`:

| Key | Default | Description | Read by |
|---|---|---|---|
| `agent.confidence_cross_model` | `false` | Phase D shadow cross-model agreement signal | **NOTHING** (only `admin-flags.ts` lists it; `process.env.AGENT_CONFIDENCE_CROSS_MODEL` is read in `config.ts:172` instead) |
| `mcp.auth_dev_mode` | `false` | Bypasses MCP JWT validation | **NOTHING** (env var `MCP_AUTH_DEV_MODE` is read in `services/mcp_tools/common/auth.py:225`) |
| `chemclaw.dev_mode` | `false` | Top-level dev-mode toggle | **NOTHING** (env vars read in 5+ places) |
| `mock_eln.enabled` | `false` | Enables the local mock-ELN testbed | **NOTHING** (`mock_eln_enabled` is a pydantic_settings field in `mcp_eln_local/main.py:72` reading the env var) |

**Zero of the four seeded flags are actually consulted at runtime.** This is the most concerning finding in the audit — admins toggling these get no behaviour change.

### 1C. `process.env.X` references in TypeScript

Counted via `grep -rEn 'process\.env\.[A-Z_]+' services/agent-claw/src/ services/paperclip/src/`:

| Env var | Source file:line | Classification | Note |
|---|---|---|---|
| `AGENT_ADMIN_USERS` | middleware/require-admin.ts:48 | LEGITIMATE bootstrap | First-admin seed; documented as bootstrap-only in CLAUDE.md |
| `AGENT_LOG_LEVEL` | observability/logger.ts:78 | LEGITIMATE bootstrap | Pino level |
| `AGENT_SHADOW_SAMPLE` | prompts/shadow-evaluator.ts:112 | should be config_setting (`agent.shadow_sample`) | Already in config.ts as Zod-parsed |
| `CHEMCLAW_DEV_MODE` | observability/user-hash.ts:45 | LEGITIMATE bootstrap | Boot gate |
| `DB_SLOW_TXN_MS` | db/with-user-context.ts:31 | should be config_setting (`db.slow_txn_ms`) | Already not in `.env.example` |
| `LANGFUSE_HOST/PUBLIC_KEY/SECRET_KEY` | observability/otel.ts:50,66-67; tools/builtins/induce_forged_tool_from_trace.ts:42-44 | LEGITIMATE secrets | Outbound creds |
| `LOG_USER_SALT` | observability/user-hash.ts:40 | LEGITIMATE secret | Salt; required outside dev |
| `MCP_AUTH_SIGNING_KEY` | security/mcp-tokens.ts:78,145; security/mcp-token-cache.ts:76 | LEGITIMATE secret | JWT signing |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | observability/otel.ts:50 | LEGITIMATE bootstrap | Endpoint URL |
| `PAPERCLIP_HEARTBEAT_TTL_MS` | paperclip/src/index.ts:33 | should be config_setting (`paperclip.heartbeat_ttl_ms`) | |
| `PAPERCLIP_HOST` | paperclip/src/index.ts:28 | LEGITIMATE bootstrap | Bind host |
| `PAPERCLIP_MAX_CONCURRENT` | paperclip/src/index.ts:29 | should be config_setting (`paperclip.max_concurrent`) | |
| `PAPERCLIP_MAX_TOKENS` | paperclip/src/index.ts:30 | should be config_setting (`paperclip.max_tokens`) | |
| `PAPERCLIP_MAX_USD_PER_DAY` | paperclip/src/index.ts:31 | should be config_setting (`paperclip.max_usd_per_day`) | |
| `PAPERCLIP_PG_DSN` | paperclip/src/index.ts:57 | LEGITIMATE secret | DB DSN |
| `PAPERCLIP_PORT` | paperclip/src/index.ts:27 | LEGITIMATE bootstrap | Bind port |
| `PAPERCLIP_REFRESH_INTERVAL_MS` | paperclip/src/index.ts:255 | should be config_setting | |
| `PAPERCLIP_SKIP_START` | paperclip/src/index.ts:275 | LEGITIMATE bootstrap | Test-only |
| `PAPERCLIP_STALE_MS` | paperclip/src/index.ts:32 | should be config_setting | |
| `SANDBOX_ALLOW_NET_EGRESS` | core/sandbox.ts:61 | should be feature_flag (`sandbox.allow_net_egress`) | Currently dual: same value also under `SANDBOX_MAX_NET_EGRESS` (line 62) — typo? |
| `SANDBOX_MAX_CPU_S` | core/sandbox.ts:51 | should be config_setting (`sandbox.max_cpu_s`) | |
| `SANDBOX_MAX_NET_EGRESS` | core/sandbox.ts:62 | DUPLICATE of `SANDBOX_ALLOW_NET_EGRESS` | One of the two should be deleted |

Plus all 35 vars in `services/agent-claw/src/config.ts` Zod schema — those are loaded at boot via `loadConfig()` and never re-read. They constitute the legitimate bootstrap layer.

### 1D. `os.environ` / `os.getenv` references in Python

Counted across `services/`. Identified 46 distinct names in non-test code paths.

| Env var | Source file:line | Classification |
|---|---|---|
| `AIZYNTH_CONFIG` | mcp_aizynth/main.py:28 | LEGITIMATE bootstrap (config file path) |
| `ASKCOS_MODEL_DIR` | mcp_askcos/main.py:32 | LEGITIMATE bootstrap |
| `CHEMBENCH_DATASET_PATH` | optimizer/eval_chemistry/eval_chembench_subset.py:32 | LEGITIMATE bootstrap (CLI tool) |
| `CHEMCLAW_DEV_MODE` | mcp_tools/common/user_hash.py:43 | LEGITIMATE bootstrap |
| `CHEMCLAW_SERVICE_DSN` | mcp_yield_baseline/scripts/build_global_xgb.py:68; mcp_applicability_domain/scripts/build_drfp_stats.py:21 | DSN drift (see C1) |
| `CHEMPROP_MODEL_DIR` | mcp_chemprop/main.py:28 | LEGITIMATE bootstrap |
| `DOYLE_DATASET_PATH` | optimizer/eval_chemistry/eval_doyle_buchwald.py:34; mcp_yield_baseline/scripts/eval_doyle.py:29 | LEGITIMATE bootstrap (CLI tool) |
| `GEPA_MODEL` | optimizer/gepa_runner/runner.py:66 | should be config_setting (`gepa.model`) |
| `GEPA_PORT` | optimizer/gepa_runner/runner.py:362 | LEGITIMATE bootstrap |
| `HF_HOME` | mcp_embedder/main.py:25 | LEGITIMATE bootstrap (HuggingFace cache) |
| `LITELLM_API_KEY` | optimizer/gepa_runner/runner.py:59; mcp_synthegy_mech/llm_policy.py:72 | LEGITIMATE secret |
| `LITELLM_BASE_URL` | optimizer/gepa_runner/runner.py:58; optimizer/scripts/seed_golden_set.py:95; mcp_synthegy_mech/llm_policy.py:71 | LEGITIMATE bootstrap (URL) |
| `LITELLM_PLANNER_MODEL` | optimizer/scripts/seed_golden_set.py:91 | should be config_setting |
| `LITELLM_REDACTION_LOG_SAMPLE` | litellm_redactor/callback.py:28 | should be config_setting (`litellm.redaction_log_sample`) |
| `LOG_ACCESS_PROBES` | mcp_tools/common/app.py:360 | LEGITIMATE bootstrap (log gate) |
| `LOG_FORMAT` | mcp_tools/common/logging.py:135 | LEGITIMATE bootstrap |
| `LOG_LEVEL` | mcp_yield_baseline/scripts/build_global_xgb.py:23 | LEGITIMATE bootstrap |
| `LOG_USER_SALT` | mcp_tools/common/user_hash.py:38 | LEGITIMATE secret |
| `LOGS_ALLOW_DEV_PASSWORD` | mcp_tools/conftest.py:36 | LEGITIMATE test-only |
| `MCP_AUTH_DEV_MODE` | mcp_tools/common/auth.py:225 | LEGITIMATE bootstrap |
| `MCP_AUTH_REQUIRED` | mcp_tools/common/auth.py:224 | LEGACY (Phase 7 says default fail-closed; flag is back-compat only) |
| `MCP_AUTH_SIGNING_KEY` | mcp_tools/common/auth.py:96,148; mcp_tools/common/mcp_token_cache.py:69 | LEGITIMATE secret |
| `MCP_CHEMPROP_URL` | mcp_yield_baseline/main.py:107 | service URL (C0 — not in compose env for yield_baseline) |
| `MCP_CREST_URL` | workflow_engine/main.py:269 | service URL |
| `MCP_DOC_FETCHER_ALLOW_HOSTS/DENY_HOSTS/FILE_ROOTS` | mcp_doc_fetcher/validators.py:48,56,64 | should be config_setting (per-tenant allowlist) — currently env-only |
| `MCP_DRFP_URL` | mcp_yield_baseline/main.py:103; mcp_yield_baseline/scripts/build_global_xgb.py:83 | service URL |
| `MCP_GENCHEM_URL` | workflow_engine/main.py:270 | service URL (drift between this default `:8015` and config.ts `:8023` — see `03-architecture.md` Finding 5) |
| `MCP_TABICL_PCA_PATH` | mcp_tabicl/main.py:23 | LEGITIMATE bootstrap |
| `MCP_TABICL_ADMIN_TOKEN` | mcp_tabicl/main.py:165 | LEGACY (parallel auth surface — see C2) |
| `MCP_XTB_BASE_URL` | mcp_synthegy_mech/main.py:55 | service URL (used for MCP-to-MCP calls) |
| `MCP_XTB_STEP_TIMEOUT_SECONDS` | mcp_xtb/main.py:116 | should be config_setting (`xtb.step_timeout_s`) |
| `MCP_XTB_URL` | workflow_engine/main.py:264-268 | service URL |
| `MCP_XTB_WORKFLOW_TIMEOUT_SECONDS` | mcp_xtb/main.py:125 | should be config_setting (`xtb.workflow_timeout_s`) |
| `MCP_YIELD_BASELINE_URL` | optimizer/eval_chemistry/eval_doyle_buchwald.py:43; mcp_yield_baseline/scripts/eval_doyle.py:25 | service URL (CLI scripts) |
| `MOCK_ELN_ALLOW_DEV_PASSWORD` | mcp_tools/conftest.py:35 | LEGITIMATE test-only |
| `NEO4J_URI/USER/PASSWORD` | projectors/kg_hypotheses/main.py:35-37 | LEGITIMATE secrets |
| `POSTGRES_DSN` | mcp_genchem/main.py:67; mcp_tools/common/qm_cache_db.py:56 | DSN drift (see C1) |
| `POSTGRES_HOST/PORT/DB/USER/PASSWORD` | 8 services rebuild DSN from these | DSN drift (see C1) — every service ships its own concat |
| `PYTEST_CURRENT_TEST` | mcp_tools/common/user_hash.py:45 | LEGACY (security risk; see `04-security.md` F-6 + C1 here) |
| `REDACTOR_PG_DSN` | litellm_redactor/dynamic_patterns.py:72 | DSN drift |
| `SKILL_PROMOTER_PORT` | optimizer/skill_promoter/runner.py:104 | LEGITIMATE bootstrap |
| `WORLD_SEED` | mock_eln/seed/generator.py:507; mock_eln/seed/fake_logs_generator.py:476 | LEGITIMATE bootstrap (deterministic seed) |

### 1E. Hardcoded constants that look like tunables

Grep'd `services/agent-claw/src/` and `services/optimizer/`:

| Constant | File:line | Value | Should be |
|---|---|---|---|
| `TIMEOUT_TABICL_MS` | tools/builtins/statistical_analyze.ts:82 | 60_000 | config_setting |
| `TIMEOUT_SYNTHEGY_MECH_MS` | tools/builtins/elucidate_mechanism.ts:114 | 300_000 | config_setting |
| `TIMEOUT_BYTES_MS` / `TIMEOUT_PDF_PAGES_MS` | tools/builtins/fetch_original_document.ts:106-107 | 60_000 each | config_setting |
| `TIMEOUT_EMBED_MS` | tools/builtins/search_knowledge.ts:82 | 15_000 | config_setting |
| `TIMEOUT_ASKCOS_MS` / `TIMEOUT_AIZYNTH_MS` | tools/builtins/propose_retrosynthesis.ts:54-55 | 30_000 / 60_000 | config_setting |
| `TIMEOUT_KG_MS` | tools/builtins/expand_reaction_context.ts:105 | 15_000 | config_setting |
| `TIMEOUT_DRFP_MS` / `TIMEOUT_DB_MS` | tools/builtins/find_similar_reactions.ts:66-67 | 15_000 / 20_000 | config_setting |
| `TIMEOUT_MS` | (21 builtin files) | various | config_setting |
| `MAX_BATCH_SMILES` / `MAX_BATCH_RXN_SMILES` | tools/_limits.ts:20,23 | 100 / 1000 | OK as constant (input validation, not tunable) |
| `DEFAULT_TTL_SECONDS` | security/mcp-token-cache.ts:49 | 300 | OK (must match server-side TTL) |
| `_CACHE_TTL_MS` | config/registry.ts:27, config/flags.ts:29, prompts/registry.ts:40 | 60_000 each | OK (ergonomics) |
| `PROMOTION_SUCCESS_RATE` | optimizer/skill_promoter/promoter.py:33 | 0.55 | **explicitly named in CLAUDE.md as the example config_setting** — still hardcoded |
| `DEMOTION_SUCCESS_RATE` | optimizer/skill_promoter/promoter.py:34 | 0.40 | config_setting |
| `MIN_RUNS` | optimizer/skill_promoter/promoter.py:35 | 30 | config_setting |
| `PROMPT_PROMOTION_FLOOR` / `_DELTA` / `_PER_CLASS_REGRESSION` | optimizer/skill_promoter/promoter.py:254-256 | 0.80 / 0.05 / 0.02 | config_setting |
| `FEEDBACK_WEIGHT` / `GOLDEN_WEIGHT` / `CITATION_WEIGHT` | optimizer/gepa_runner/metric.py:24-26 | 0.50 / 0.30 / 0.20 | config_setting |
| `MIN_EXAMPLES_PER_CLASS` | optimizer/gepa_runner/examples.py:19 | 30 | config_setting |
| `_DEFAULT_MAX_REDACTION_INPUT_LEN` | litellm_redactor/redaction.py:35 | 5 MiB | config_setting |
| `_CATCHUP_BATCH` | projectors/common/base.py:37 | 1000 | config_setting |
| `_NOTIFY_POLL_TIMEOUT_S` | projectors/common/base.py:38 | 5.0 | config_setting |

---

## 2. Naming-Convention Findings

CLAUDE.md says feature flags are `lowercase, dotted (mock_eln.enabled, agent.x_y)`. The four seeded rows comply. config_settings keys have no documented convention but the only example in code uses the same shape (`agent.max_active_skills`) — it would be defensible to enforce both share the convention.

| Source | Naming convention | Examples | Inconsistencies |
|---|---|---|---|
| `feature_flags.key` | lowercase, dotted | `mock_eln.enabled`, `agent.confidence_cross_model`, `chemclaw.dev_mode`, `mcp.auth_dev_mode` | None among the 4 rows. CHECK constraint at `db/init/22_feature_flags.sql` does NOT enforce the convention — admin can insert `MyFlag` and the env-var fallback (`flags.ts:111`) silently maps it to `MYFLAG` |
| `config_settings.key` | (undocumented; `agent.max_active_skills` is the only example) | `agent.max_active_skills` | No explicit DB CHECK; `admin-config.ts` uppercases via `key_prefix LIKE` only |
| Env vars | UPPER_SNAKE | `MCP_AUTH_SIGNING_KEY` | Mostly consistent. **Outlier: `mock_eln.enabled` is read in `mcp_eln_local/main.py` as `mock_eln_enabled` (pydantic_settings normalises)** — env var would be `MOCK_ELN_ENABLED`. The convention round-trips via the flags.ts envFallback function. |
| TS constant names | `SCREAMING_SNAKE` | `TIMEOUT_KG_MS`, `MAX_BATCH_SMILES` | Consistent |
| Python constant names | `SCREAMING_SNAKE` | `_DEFAULT_STEP_TIMEOUT_S` | Consistent |
| permission_policies | `tool_pattern` is a glob | `mcp__github__*`, `Bash` | Consistent enough |
| redaction_patterns categories | UPPER (8 enum values) | `SMILES`, `RXN_SMILES`, `EMAIL`, `NCE`, `CMP`, `COMPOUND_CODE`, `PROJECT_ID`, `CUSTOM` | OK (DB CHECK enforces) |

**Recommendation:** add a CHECK constraint to both `feature_flags` and `config_settings` enforcing `key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'` (lowercase, dotted, at least one dot). It's a one-line migration that makes the convention machine-checked rather than a CLAUDE.md sentence.

---

## 3. Cache-Invalidation Completeness Matrix

| Cache singleton | Owning admin route | Calls `.invalidate()` after write? | Evidence |
|---|---|---|---|
| `ConfigRegistry` (TS, `config/registry.ts`) | admin-config.ts | **YES** (PATCH and DELETE) | admin-config.ts:178 `getConfigRegistry().invalidate(key)`; admin-config.ts:239 same |
| `FeatureFlagRegistry` (TS, `config/flags.ts`) | admin-flags.ts | **YES** (POST and DELETE) | admin-flags.ts:121 `getFeatureFlagRegistry().invalidate()`; admin-flags.ts:157 same |
| `PermissionPolicyLoader` (TS, `core/permissions/policy-loader.ts`) | admin-permissions.ts | **YES** (POST, PATCH, DELETE) | admin-permissions.ts:143,193,233 `getPermissionPolicyLoader()?.invalidate()` |
| `DynamicPatternLoader` (Python, `litellm_redactor/dynamic_patterns.py`) | admin-redaction.ts (TS) | **NO** — and structurally cannot, since the loader is in a different process | Cross-process gap: TS admin route mutates the table; Python LiteLLM-gateway loader has its own 60s TTL cache. **C1 above.** |
| `PromptRegistry` (TS, `prompts/registry.ts`) | (none — no admin route exists) | **N/A** — no admin route | `grep -rn 'INSERT INTO prompt_registry\|UPDATE prompt_registry' services/agent-claw/` returns nothing. Prompts are mutated via direct SQL or by the optimizer's GEPA runner; the agent's PromptRegistry has an `invalidate()` method (line 229) but no caller invokes it. The 60s TTL is the only propagation guarantee. |
| `SkillLoader` (TS, `core/skills.ts`) | (none — `routes/forged-tools.ts` and `routes/learn.ts` mutate `skill_library` directly) | **NO** — SkillLoader has NO `invalidate()` method | `grep -n 'invalidate' services/agent-claw/src/core/skills.ts` returns no match. Loader caches max-active-skills cap (TTL 60s, line 217); skills themselves are read fresh. **No race window in practice but inconsistent with the rest.** |
| Python `ConfigRegistry` (`services/common/config_registry.py`) | admin-config.ts | **NO** — singleton lives in a separate Python process | Same cross-process gap as redaction patterns. The 60s TTL is the only propagation guarantee. **Mitigated** because today no Python service consumes it (C1 above), so there's nothing to invalidate. |

**Verdict:** the four TS-side singletons (config, flags, permissions, redaction-mutation triggers) are correctly invalidated for in-process readers. The two cross-process loaders (Python redaction, Python config) are not — they live in different containers from the admin route. Acceptable for now (60s convergence), but the route response should disclose the propagation delay so admins don't think a write is instantaneous everywhere.

---

## 4. Tenant-Isolation Boundary

CLAUDE.md says: *"Adding a fundamentally NEW category (not a tenant-specific variation) still extends the hardcoded baseline + tests/unit/test_redactor.py; the DB table is for tenant variation, not new categories."*

**Audit of `services/litellm_redactor/redaction.py`:**

The five compiled-in patterns are CATEGORIES, not tenant-specific values:

- `_SMILES_TOKEN` — SMILES is universal (chemistry notation)
- `_RXN_SMILES` — RXN_SMILES is universal
- `_EMAIL` — universal
- `_NCE_PROJECT` — `r"\bNCE-\d{1,6}\b"` — **the literal prefix `NCE` is a chemclaw-internal naming convention**, not industry-universal. A pharma org using a different new-chemical-entity tag (e.g. `MOL-`, `CAND-`) gets no protection from this row. This is a borderline tenant-specific value — tightening the rule would put `NCE-` in the DB.
- `_COMPOUND_CODE` — `r"\bCMP-\d{4,8}\b"` — comment says **"default prefix"**. The literal prefix `CMP` is exactly the kind of tenant-specific value CLAUDE.md says belongs in the table.

**Verdict:** the `NCE-` and `CMP-` prefixes in the hardcoded baseline are tenant-specific values that CLAUDE.md's own rule would put in `redaction_patterns`. The seed at `db/init/20_redaction_patterns.sql:81-90` already has corresponding rows — but the compiled-in code STILL fires them on every prompt regardless of the row's `enabled` state (see C2 above). Net: the rule was followed half-way — the rows were created but the compiled-in versions weren't deleted. Either:

- (a) **Delete `_NCE_PROJECT` and `_COMPOUND_CODE` from `redaction.py`** and let the DB rows drive the behaviour (the rule's intent), accepting that tenants whose DB is unreachable lose the redaction (mitigated by the loader's try/except keeping the gateway up). OR
- (b) **Keep them as the safety baseline** and explicitly document that the DB rows for these two categories are advisory / discoverability-only and have no effect when the corresponding compiled-in pattern is enabled.

Both are defensible; today the code is in a third state (both fire, the DB toggle does nothing for these two categories) which is the worst of all worlds.

The `_SMILES_TOKEN`, `_RXN_SMILES`, `_EMAIL` patterns are correctly universal-baseline.

---

## 5. Recommended Service Registry

### The pattern observed in Wave 1

When a new MCP service lands today, the diff touches all of these files:

1. `services/agent-claw/src/security/mcp-token-cache.ts:26-47` — add scope mapping
2. `services/mcp_tools/common/scopes.py:20-41` — add scope mapping (Python mirror)
3. `services/agent-claw/src/config.ts` — add `MCP_<NAME>_URL` Zod field with default
4. `services/agent-claw/src/bootstrap/dependencies.ts:185+` — register the builtin tool
5. `docker-compose.yml` — add service block, EXPOSE port, allocate port, set `MCP_AUTH_SIGNING_KEY: ${MCP_AUTH_SIGNING_KEY:?required}` env
6. `infra/helm/values.yaml` — add `chemistry.mcp<Name>: { image, port, replicas }`
7. `infra/helm/templates/chemistry-deployments.yaml` — add a dict entry
8. `.env.example` — add `MCP_<NAME>_URL=http://localhost:<port>`
9. `Dockerfile` — set port for EXPOSE / CMD

**Wave 1 evidence of drift across this list:**

- `mcp-applicability-domain` and `mcp-green-chemistry` got 4 of 9 (missed both SERVICE_SCOPES; cf. `01-merge-integrity.md` F-01) → JWT mint throws
- `mcp-genchem` got compose port 8015 but config.ts default 8023 (cf. `03-architecture.md` Finding 5)
- `mcp-yield-baseline` collides with `mcp-genchem` on 8015 (cf. `01-merge-integrity.md` F-02; `03-architecture.md` Finding 1)
- `mcp-eln-local` and `mcp-logs-sciy` got compose+helm but missed `MCP_AUTH_SIGNING_KEY` env (cf. `03-architecture.md` Finding 3)
- 11 services missing from helm chart entirely (cf. `01-merge-integrity.md` F-05)

That's ≥ 5 distinct landings each missing ≥ 1 file. The pattern isn't "developer was sloppy"; it's "the system has no registry, so nine independent edits race."

### Proposal: `services/agent-claw/src/config/services.ts`

```ts
// services/agent-claw/src/config/services.ts
//
// Single source of truth for the MCP service catalog. Every cross-file map
// (SERVICE_SCOPES in TS + Python, config.ts URL defaults, helm values,
// .env.example URL block, builtin URL helper) derives from this file.
//
// Adding a new MCP service is one PR with one file edit:
//   1. Add a row here
//   2. Run `make codegen` (regenerates .env.example block, helm values,
//      Python scopes.py) — generated files have a banner refusing edits
//   3. Add the service block to docker-compose.yml (no codegen for that
//      yet; see follow-up §5.B below)

export interface McpServiceDef {
  /** Compose / Helm container name (kebab-case). */
  name: string;
  /** TCP port (host AND container — we always 1:1 map). */
  port: number;
  /** Coarse-by-service scope minted into JWTs. */
  scope: string;
  /** Env var consumed by agent-claw config.ts to override URL. */
  urlEnvVar: string;
  /** Helm values key (camelCase). */
  helmKey: string;
  /** Helm profile / sub-chart this service belongs to. */
  profile: "chemistry" | "sources" | "testbed" | "default";
  /** Whether the service-side requires `MCP_AUTH_SIGNING_KEY` set in compose. */
  requiresAuthEnv: boolean;
  /** Short description for .env.example comments. */
  description: string;
}

export const MCP_SERVICES: readonly McpServiceDef[] = [
  { name: "mcp-rdkit", port: 8001, scope: "mcp_rdkit:invoke",
    urlEnvVar: "MCP_RDKIT_URL", helmKey: "mcpRdkit", profile: "default",
    requiresAuthEnv: true, description: "RDKit cheminformatics" },
  { name: "mcp-drfp", port: 8002, scope: "mcp_drfp:invoke",
    urlEnvVar: "MCP_DRFP_URL", helmKey: "mcpDrfp", profile: "default",
    requiresAuthEnv: true, description: "DRFP reaction fingerprints" },
  // ... 18 more rows ...
];

// Derived maps used by mcp-token-cache.ts and config.ts.
export const SERVICE_SCOPES: Record<string, string> =
  Object.fromEntries(MCP_SERVICES.map(s => [s.name, s.scope]));

export function defaultUrlFor(envVar: string): string | undefined {
  const svc = MCP_SERVICES.find(s => s.urlEnvVar === envVar);
  return svc ? `http://localhost:${svc.port}` : undefined;
}
```

### Migration plan

1. **Land `services.ts` with all 20 current services** (1 PR). The file is the new source of truth.
2. **Replace `SERVICE_SCOPES` in `mcp-token-cache.ts`** with `import { SERVICE_SCOPES } from "../config/services.js"` (same shape; one-line edit). **Net delete: 22 lines** (the literal map + comments). **Net add: 1 line.**
3. **Replace `config.ts` URL defaults** with `defaultUrlFor("MCP_<X>_URL")` calls. The Zod schema entry stays but the `.default(...)` becomes `.default(defaultUrlFor("MCP_<X>_URL")!)`. **Net delete: 0; Net add: 0** (cosmetic — just removes the per-port literals).
4. **Generate `services/mcp_tools/common/scopes.py`** from `services.ts` via a `make codegen` script (~30 LOC of `tsx` running over the registry). Banner the generated file:
   ```py
   # AUTOGENERATED FROM services/agent-claw/src/config/services.ts
   # Do not edit by hand. Run `make codegen` after editing the .ts file.
   ```
   **Net delete: 22 lines** (the manual map). **Net add: ~30 LOC of codegen.**
5. **Generate the `.env.example` MCP URL block** from the registry (similar codegen). **Net delete: ~15 lines**.
6. **Generate `infra/helm/values.yaml` chemistry/sources/testbed sub-trees** from the registry. **Net delete: ~50 lines**.
7. **Add a `tests/integration/test_service_registry_pact.py`** that:
   - Loads the registry
   - Verifies every entry's `name` appears as a service in `docker-compose.yml`
   - Verifies the port matches
   - Verifies `MCP_AUTH_SIGNING_KEY` is set in compose env iff `requiresAuthEnv: true`
   - Verifies every entry appears in helm
   - Verifies SERVICE_SCOPES (derived) matches the Python codegen output
   - The pact test runs in CI so a future drift fails immediately at PR time

### Estimated impact

| File | Current LOC | After | Net |
|---|---|---|---|
| `services.ts` (NEW) | 0 | ~120 | +120 |
| `mcp-token-cache.ts` SERVICE_SCOPES | 22 | 1 | -21 |
| `scopes.py` (autogenerated) | 22 | ~30 (with banner) | +8 |
| `.env.example` MCP URL block | ~25 | autogenerated | -25 / +regen |
| `helm/values.yaml` chemistry tree | ~80 | autogenerated | -80 / +regen |
| `Makefile` codegen target (NEW) | 0 | ~30 | +30 |
| Pact test (NEW) | 0 | ~80 | +80 |
| **Total** | — | — | **~+120 net** |

### Risks

- **Codegen complexity** — running `tsx scripts/codegen-services.ts` adds a dev-loop step. Mitigation: make the generated files first-class (committed to the repo), so a fresh clone doesn't need codegen to build; codegen runs on `make precommit` and CI verifies.
- **Compose still hand-edited** — the registry doesn't auto-generate compose because compose has too much per-service variation (volumes, healthchecks, profiles, GPU specs). Mitigation: the pact test (step 7) catches the ones that matter (port, auth env). Long-term, a compose generator could land but it's a separate PR.
- **TS-Python boundary** — every codegen step crosses it. Tests must run both languages to verify drift.

### Touched files (full list)

`services/agent-claw/src/config/services.ts` (NEW), `services/agent-claw/src/security/mcp-token-cache.ts`, `services/agent-claw/src/config.ts`, `services/mcp_tools/common/scopes.py` (autogenerated, banner added), `infra/helm/values.yaml` (autogenerated), `.env.example` (autogenerated MCP block), `Makefile` (new `codegen` target), `tests/integration/test_service_registry_pact.py` (NEW), `scripts/codegen-services.ts` (NEW). 9 files; 8 of them have a single autogenerated source.

### What this fixes

- **C0 (this audit):** every new MCP is one row, codegen does the rest.
- **`01-merge-integrity.md` F-01 (P0)** SERVICE_SCOPES gap — codegen makes it impossible.
- **`03-architecture.md` Finding 1 (P1)** port collision — pact test detects on PR.
- **`03-architecture.md` Finding 3 (P2)** missing auth env — pact test detects on PR.
- **`01-merge-integrity.md` F-05 (P1)** helm chart 11 missing services — codegen.

The cost is one ~500-LOC PR. The benefit is killing an entire bug class.

---

## 6. Tenant-Isolation Boundary

Already covered in §4 above. Summary: the hardcoded `NCE-` and `CMP-` prefixes in `redaction.py` are tenant-specific values per CLAUDE.md's own rule; the seeded DB rows duplicate them; both paths fire today (causing double-redaction with identical placeholders, harmless but confusing). Recommend deleting the two patterns from `redaction.py` and treating the DB rows as authoritative — OR formally reclassifying the prefixes as universal-pharma defaults. Pick one.

---

## 7. Bootstrap-Fallback Hygiene Tables

### 7A. Primary env vars (legitimate boot-time secrets — must remain env)

| Env var | Reason |
|---|---|
| `POSTGRES_PASSWORD`, `CHEMCLAW_APP_PASSWORD`, `CHEMCLAW_SERVICE_PASSWORD` | DB role passwords; can't read from DB |
| `NEO4J_PASSWORD` | KG password |
| `MCP_AUTH_SIGNING_KEY` | JWT signing key; must be available before DB connects |
| `LOG_USER_SALT` | Salt; required outside dev |
| `LITELLM_MASTER_KEY` | Egress proxy key |
| `LITELLM_API_KEY` | Provider key |
| `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_NEXTAUTH_SECRET`, `LANGFUSE_ENCRYPTION_KEY`, `LANGFUSE_CLICKHOUSE_PASSWORD`, `LANGFUSE_POSTGRES_PASSWORD` | Tracing creds |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` | Provider keys |
| `BENCHLING_API_KEY`, `STARLIMS_TOKEN`, `WATERS_API_KEY`, `STARLIMS_USER` | Source-system creds |
| `ENTRA_*`, `OAUTH2_PROXY_COOKIE_SECRET` | Identity provider |
| `E2B_API_KEY` | Sandbox API |
| `AGENT_PORT`, `AGENT_HOST`, `PAPERCLIP_PORT`, `PAPERCLIP_HOST`, `GEPA_PORT`, `SKILL_PROMOTER_PORT` | Bind specs (boot before DB) |
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER` | DB connection (boot-only) |
| `CHEMCLAW_DEV_MODE` | Boot gate (forces fail-closed when not "true") |
| `MCP_AUTH_DEV_MODE` | Boot gate |
| `LOG_LEVEL`, `AGENT_LOG_LEVEL`, `LOG_FORMAT` | Pre-DB logging |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Pre-DB tracing endpoint |
| `WORLD_SEED` | CLI tool seed (fake_logs / mock_eln seeders) |

### 7B. Fallback env vars (should be config_setting; env is the bootstrap default only)

| Env var | Proposed config_setting key | Currently consumed by |
|---|---|---|
| `AGENT_RATE_LIMIT_MAX` / `_WINDOW_MS` | `agent.rate_limit_max` / `_window_ms` | config.ts:29-30 (boot only) |
| `AGENT_CHAT_RATE_LIMIT_MAX` / `_WINDOW_MS` | `agent.chat.rate_limit_max` / `_window_ms` | config.ts:50-51 |
| `AGENT_CHAT_MAX_STEPS` | `agent.chat.max_steps` | config.ts:33 |
| `AGENT_CHAT_MAX_HISTORY` | `agent.chat.max_history` | config.ts:55 |
| `AGENT_CHAT_MAX_INPUT_CHARS` | `agent.chat.max_input_chars` | config.ts:54 |
| `AGENT_TOKEN_BUDGET` | `agent.token_budget` | config.ts:36 |
| `AGENT_SESSION_INPUT_TOKEN_BUDGET` / `_OUTPUT_` | `agent.session.input_token_budget` / `output` | config.ts:41-42 |
| `AGENT_PLAN_MAX_AUTO_TURNS` | `agent.plan.max_auto_turns` | config.ts:47 |
| `AGENT_BODY_LIMIT_BYTES` | `agent.body_limit_bytes` | config.ts:22 |
| `AGENT_SHADOW_SAMPLE` | `agent.shadow_sample` | config.ts:182, shadow-evaluator.ts:112 |
| `AGENT_CONFIDENCE_CROSS_MODEL` | `agent.confidence_cross_model` (already a feature_flag, but unread) | config.ts:172 |
| `POSTGRES_STATEMENT_TIMEOUT_MS` / `_CONNECT_` / `_POOL_SIZE` | `db.statement_timeout_ms` / etc | config.ts:70-81 |
| `DB_SLOW_TXN_MS` | `db.slow_txn_ms` | with-user-context.ts:31 |
| `MCP_XTB_STEP_TIMEOUT_SECONDS` / `_WORKFLOW_` | `xtb.step_timeout_s` / `xtb.workflow_timeout_s` | mcp_xtb/main.py:116,125 |
| `LITELLM_REDACTION_LOG_SAMPLE` | `litellm.redaction_log_sample` | callback.py:28 |
| `MCP_DOC_FETCHER_ALLOW_HOSTS` / `_DENY_HOSTS` / `_FILE_ROOTS` | `mcp_doc_fetcher.allow_hosts` / `_deny_hosts` / `_file_roots` (per-tenant!) | validators.py:48-64 |
| `SANDBOX_MAX_CPU_S` | `sandbox.max_cpu_s` | sandbox.ts:51 |
| `SANDBOX_ALLOW_NET_EGRESS` | feature_flag `sandbox.allow_net_egress` | sandbox.ts:61 |
| `PAPERCLIP_*` (the 5 tunable ones) | `paperclip.*` | paperclip/src/index.ts:27-33,255 |
| `GEPA_MODEL` | `gepa.model` | gepa_runner/runner.py:66 |
| `LITELLM_PLANNER_MODEL` | `litellm.planner_model` | scripts/seed_golden_set.py:91 |
| `POLL_INTERVAL_SECONDS` (reanimator/purger) | `optimizer.<daemon>.poll_interval_s` | session_reanimator/main.py:71; session_purger/main.py:58 |
| `BATCH_SIZE`, `STALE_AFTER_SECONDS` | `optimizer.<daemon>.*` | same |

### 7C. Legacy env vars (should be deleted)

| Env var | Reason | Replace with |
|---|---|---|
| `MCP_AUTH_REQUIRED` | Phase 7 says default fail-closed; this is back-compat only. CLAUDE.md says "still honoured for backward-compat and overrides dev mode when both are set; routes no longer need to defensively check." | Delete after a deprecation cycle; rely on `MCP_AUTH_DEV_MODE=true` for opt-out only |
| `PYTEST_CURRENT_TEST` (read by `user_hash.py`) | Security risk — pytest sets this and a misconfigured prod with pytest at startup leaks the salt | Delete; require explicit `CHEMCLAW_DEV_MODE=true` |
| `MCP_TABICL_ADMIN_TOKEN` | Parallel auth surface | Replace with `mcp_tabicl:admin` JWT scope |
| `MCP_ELN_BENCHLING_URL`, `MCP_LIMS_STARLIMS_URL`, `MCP_INSTRUMENT_WATERS_URL` | Reference deleted vendor adapters; nothing reads them | Delete from `.env.example` |
| `SANDBOX_MAX_NET_EGRESS` (vs `SANDBOX_ALLOW_NET_EGRESS`) | The two are read on adjacent lines (`sandbox.ts:61-62`) and OR'd; one is a typo / leftover | Pick one; delete the other |
| `POSTGRES_DSN` and `REDACTOR_PG_DSN` and `CHEMCLAW_SERVICE_DSN` | Three concurrent DSN names | Pick one (recommend `*_DSN` form); decompose inside services |
| `BENCHLING_BASE_URL`, `STARLIMS_BASE_URL`, `EMPOWER_BASE_URL`, `BENCHLING_API_KEY`, `STARLIMS_USER`, `STARLIMS_TOKEN`, `WATERS_API_KEY` | Reference deleted vendor adapters | Delete from `.env.example` (commented in §3D-replacement after F.2 reboot) |

---

## 8. .env.example Drift Matrix

### 8A. Documented in `.env.example` but NOT consumed by code

`grep`'d each `.env.example` key against `process.env.*` and `os.environ.*` / `os.getenv.*`:

| Key | Status |
|---|---|
| `MCP_ELN_BENCHLING_URL` | UNUSED (no consumer) |
| `MCP_LIMS_STARLIMS_URL` | UNUSED |
| `MCP_INSTRUMENT_WATERS_URL` | UNUSED |
| `BENCHLING_BASE_URL` | UNUSED |
| `STARLIMS_BASE_URL` | UNUSED |
| `EMPOWER_BASE_URL` | UNUSED |
| `BENCHLING_API_KEY` | UNUSED |
| `STARLIMS_USER` | UNUSED |
| `STARLIMS_TOKEN` | UNUSED |
| `WATERS_API_KEY` | UNUSED |
| `SMB_DOCUMENTS_ROOT` | UNUSED (`grep -rEn 'SMB_DOCUMENTS_ROOT' services/` returns nothing) |
| `ELN_JSON_DROP_FOLDER` | USED only by the legacy `eln_json_importer.legacy/` (per CLAUDE.md, retired but preserved) |

### 8B. Used by code but NOT documented in `.env.example`

(Same set as §1D plus the 36-name list at C3 above. Re-listed here for completeness.)

| Env var | Source file:line | Should add to `.env.example`? |
|---|---|---|
| `AIZYNTH_CONFIG` | mcp_aizynth/main.py:28 | Yes |
| `ASKCOS_MODEL_DIR` | mcp_askcos/main.py:32 | Yes |
| `CHEMBENCH_DATASET_PATH` | optimizer/eval_chemistry/eval_chembench_subset.py:32 | Yes |
| `CHEMCLAW_SERVICE_DSN` | mcp_yield_baseline/scripts/build_global_xgb.py:68; mcp_applicability_domain/scripts/build_drfp_stats.py:21 | Yes (also resolve DSN naming drift first — see C1) |
| `CHEMPROP_MODEL_DIR` | mcp_chemprop/main.py:28 | Yes |
| `DB_SLOW_TXN_MS` | db/with-user-context.ts:31 | Yes |
| `DOYLE_DATASET_PATH` | optimizer/eval_chemistry/eval_doyle_buchwald.py:34 | Yes |
| `GEPA_MODEL`, `GEPA_PORT` | optimizer/gepa_runner/runner.py:66,362 | Yes |
| `LITELLM_API_KEY`, `LITELLM_BASE_URL`, `LITELLM_PLANNER_MODEL`, `LITELLM_REDACTION_LOG_SAMPLE` | various | Yes |
| `LOG_ACCESS_PROBES`, `LOG_FORMAT`, `LOG_LEVEL` (top-level — only sub-prefixes documented) | various | Yes |
| `MCP_APPLICABILITY_DOMAIN_URL`, `MCP_GREEN_CHEMISTRY_URL`, `MCP_PLATE_DESIGNER_URL`, `MCP_ORD_IO_URL`, `MCP_REACTION_OPTIMIZER_URL`, `MCP_LOGS_SCIY_URL`, `MCP_ELN_LOCAL_URL`, `MCP_GENCHEM_URL`, `MCP_CREST_URL` | config.ts | Yes — would have caught the genchem 8015↔8023 drift if present |
| `MCP_DOC_FETCHER_FILE_ROOTS` | mcp_doc_fetcher/validators.py:56 | Yes (only the ALLOW/DENY are documented) |
| `MCP_TABICL_PCA_PATH` | mcp_tabicl/main.py:23 | Yes |
| `MCP_TABICL_ADMIN_TOKEN` | mcp_tabicl/main.py:165 | Yes (or retire — see C2) |
| `MCP_XTB_BASE_URL` | mcp_synthegy_mech/main.py:55 | Yes (sub-distinct from `MCP_XTB_URL`) |
| `MCP_XTB_STEP_TIMEOUT_SECONDS`, `MCP_XTB_WORKFLOW_TIMEOUT_SECONDS` | mcp_xtb/main.py:116,125 | Yes |
| `MCP_YIELD_BASELINE_URL` | optimizer/eval_chemistry/eval_doyle_buchwald.py:43 | Yes |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | observability/otel.ts:50 | Yes |
| `PAPERCLIP_*` (6 of them: HEARTBEAT_TTL_MS, MAX_CONCURRENT, MAX_TOKENS, MAX_USD_PER_DAY, REFRESH_INTERVAL_MS, SKIP_START, STALE_MS, PG_DSN) | paperclip/src/index.ts | Partially (URL+MAX_CONCURRENT+TOKENS+USD doc'd; rest aren't) |
| `POSTGRES_DSN` | mcp_genchem/main.py:67; mcp_tools/common/qm_cache_db.py:56 | Yes (or resolve DSN naming) |
| `REDACTOR_PG_DSN` | litellm_redactor/dynamic_patterns.py:72 | Yes |
| `SANDBOX_MAX_CPU_S`, `SANDBOX_MAX_NET_EGRESS` | sandbox.ts | Yes |
| `SKILL_PROMOTER_PORT` | optimizer/skill_promoter/runner.py:104 | Yes |
| `WORLD_SEED` | mock_eln/seed/generator.py:507 | Yes |
| `MOCK_ELN_ALLOW_DEV_PASSWORD`, `LOGS_ALLOW_DEV_PASSWORD` | conftest.py:35-36 | Test-only — document or restrict to `tests/.env.test` |

### 8C. Default-mismatched (documented value differs from code default)

| Key | `.env.example` value | Code default | Conflict? |
|---|---|---|---|
| `AGENT_PORT` | 3101 | config.ts: 3101 | OK |
| `AGENT_RATE_LIMIT_MAX` | 120 | config.ts: 120 | OK |
| `AGENT_CHAT_MAX_STEPS` | 40 | config.ts: 40 | OK |
| `AGENT_TOKEN_BUDGET` | 120000 | config.ts: 120_000 | OK |
| `MCP_GENCHEM_URL` | (NOT DOCUMENTED) | config.ts: `:8023` | **Drift with compose `:8015`** — `.env.example` should pin one |
| `MCP_RDKIT_URL` etc. | `localhost:8001` etc. | config.ts: matching | OK for the documented ones |
| `LITELLM_BASE_URL` | (not documented at top-level) | config.ts: `localhost:4000` | Documented as `LITELLM_HOST=localhost LITELLM_PORT=4000` (decomposed) — code reads the composed URL only |
| `AGENT_BASE_URL` | `http://localhost:3101` (documented under "session_reanimator") | reanimator default `http://agent-claw:3101` | **Mismatch:** docker-compose sets the right one but a developer copying `.env.example` to localhost gets the latter as the daemon default if env override is dropped |

---

## 9. Cross-Reference: Prior Audit (2026-04-29)

The 2026-04-29 audit did NOT have a dedicated configuration / config-coherence chapter. Configuration concerns surfaced as side effects of:

- `00-summary.md:73` (M15) — "8 Python tests fail loudly when env config missing" — partially addressed; 2 of those test groups were stabilised, the rest still rely on conftest setdefault patterns.
- `00-summary.md:89` (L6) — `console.warn` calls in `config.ts` — addressed via the Pino logger migration (CLAUDE.md "Logging" section now mandates `getLogger`).
- `04-security-deps.md` — `LiteLLM moving tag` (F-2) — STILL PRESENT (cf. `04-security.md` F-3 in Wave 1).

### What's new since 2026-04-29

The Phase-2 / Phase-3 "configuration concept" PRs landed:

- `config_settings` table (PR-19_config_settings)
- `feature_flags` table (PR-22_feature_flags)
- `redaction_patterns` table (PR-20_redaction_patterns)
- `permission_policies` table (PR-21_permission_policies)
- `admin_roles` + audit log (PR-18_admin_roles_and_audit)
- TS-side ConfigRegistry, FeatureFlagRegistry, PermissionPolicyLoader — all with 60s TTL caches and admin-route invalidation
- Python-side `services/common/config_registry.py` — but **no consumers wired**

The infrastructure landed; the migration of hardcoded constants to the new tables did NOT, except for one row (`agent.max_active_skills`). The system today carries the cost of two concepts (env vars + DB table) without the benefit (admin tunability) for any but a single key.

The Wave 1 reports of this audit cycle (`01-merge-integrity.md`, `03-architecture.md`, `04-security.md`, `06-mcp-python.md`) collectively confirm:

1. The infrastructure is correct.
2. Adoption is incomplete.
3. The places where adoption SHOULD have closed bug classes (cross-team MCP additions; tenant-specific redaction; per-deployment timeouts) didn't, because the registries weren't wired in.
4. The MCP-fleet expansion specifically needs the §5 service registry to stop the bleed.

---

## 10. Verification Commands

Reproduce the central findings without re-running the audit:

```bash
# C0 — service-registry pattern (count of files touched per new MCP)
git log --since="2026-04-01" --diff-filter=A --name-only -- 'services/mcp_tools/mcp_*' \
  | sort -u

# C1 — Python ConfigRegistry consumers
grep -rEn 'ConfigRegistry\(' services/ --include='*.py' | grep -v 'tests/'

# C1 — isFeatureEnabled consumers
grep -rEn 'isFeatureEnabled' services/agent-claw/src/ | grep -v '\.test\.'

# C1 — admin-redaction invalidate calls (none expected)
grep -n 'invalidate' services/agent-claw/src/routes/admin/admin-redaction.ts

# C1 — DSN env var divergence
grep -rEn '"POSTGRES_DSN"|"REDACTOR_PG_DSN"|"CHEMCLAW_SERVICE_DSN"' services/

# C2 — naming convention adherence (feature_flags + config_settings keys)
grep -nE "^\s*\('[A-Za-z][A-Za-z0-9_.]*'" db/init/22_feature_flags.sql

# C3 — env-var documentation drift
diff <(grep -E '^[A-Z_]+=' .env.example | cut -d= -f1 | sort -u) \
     <(
       grep -rEoh 'process\.env\.[A-Z_]+' services/agent-claw/src/ services/paperclip/src/ \
         | sed 's/process\.env\.//' | sort -u
       grep -rEoh "os\.(getenv|environ\.get)\(['\"][A-Z_]+['\"]" services/ --include='*.py' \
         | grep -oE '[A-Z_]+' | sort -u
     )

# Helm-vs-compose service drift (already in 01-merge-integrity.md F-05)
diff <(awk '/^  [a-z-]+:$/{print $1}' docker-compose.yml | tr -d ':' | grep '^mcp-' | sort -u) \
     <(grep -oE 'mcp-[a-z-]+' infra/helm/templates/*.yaml | sort -u)
```

---

## Essential Files for Understanding This Topic

- `docker-compose.yml` — service inventory + ports
- `services/agent-claw/src/security/mcp-token-cache.ts:26-47` — TS SERVICE_SCOPES map
- `services/mcp_tools/common/scopes.py:20-41` — Python SERVICE_SCOPES mirror
- `services/agent-claw/src/config.ts` — bootstrap-only Zod schema
- `services/agent-claw/src/config/registry.ts` — ConfigRegistry singleton (1 consumer)
- `services/agent-claw/src/config/flags.ts` — FeatureFlagRegistry singleton (0 consumers)
- `services/common/config_registry.py` — Python mirror (0 consumers)
- `db/init/19_config_settings.sql` — table; no seed
- `db/init/22_feature_flags.sql:62-80` — flag seed (4 rows; 0 read at runtime)
- `db/init/20_redaction_patterns.sql` — pattern seed (5 rows; merge-mode against compiled-in patterns causes double-fire on global categories)
- `services/agent-claw/src/routes/admin/admin-{config,flags,redaction,permissions}.ts` — admin CRUD + invalidate calls
- `services/agent-claw/src/bootstrap/dependencies.ts:120-172` — singleton wiring
- `services/litellm_redactor/redaction.py:60-63` — tenant-specific `NCE-` / `CMP-` prefixes
- `services/litellm_redactor/dynamic_patterns.py:38-65` — `is_pattern_safe` regex safety check
- `services/optimizer/skill_promoter/promoter.py:33-35,254-256` — example of unmigrated hardcoded constants
- `infra/helm/values.yaml:92-138` — helm-side service catalog (manually maintained mirror of compose)
- `.env.example` — operator reference; out of sync with code (≥ 36 missing keys, 12 stale)

End of report.
