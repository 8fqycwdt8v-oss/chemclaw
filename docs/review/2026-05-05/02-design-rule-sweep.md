# 02 — Design Rule Sweep (Tier 1 / Agent A02)

Date: 2026-05-05
Scope: `services/**` walked file-by-file; design rules DR-01..DR-15 asserted.
Baseline: PR #87 (Z0-Z8 audit baseline) plus DRIFT-A..K closures (PRs #88..#92).

## Per-rule findings

### DR-01 — TS `console.log/warn/error` in src/

`rg "console\.(log|warn|error)" services/agent-claw/src --type ts | grep -v tests/` → **1 match**, in `services/agent-claw/src/observability/logger.ts:11` inside a comment explaining why `getLogger()` exists. No actual call sites.

Status: **clean.** Zero violations.

### DR-02 — Python `print()` / `logging.basicConfig()` in service code

`rg "^\s*print\(" services/{mcp_tools,projectors,optimizer,workflow_engine,queue,common,litellm_redactor}` → **1 match**:
- `services/optimizer/forged_tool_validator/validator.py:138` — string-template `print()` injected into a sandboxed wrapper script (not a Python statement that executes in the validator process). False positive; the print runs inside the sandbox and stdout is captured.

`rg "logging\.basicConfig" services/{mcp_tools,projectors,optimizer,workflow_engine,queue,common,litellm_redactor}` → **1 match**:
- `services/projectors/kg_documents/main.py:248` — bare `logging.basicConfig(level=...)` instead of `configure_logging(...)`.

Additionally found by extended sweep:
- `services/projectors/kg_source_cache/main.py` defines `log = logging.getLogger("projector.kg_source_cache")` and uses `log.info/.warning` but never calls `configure_logging()` — output goes to whatever default handler the runtime provides (no JSON formatter, no `RedactionFilter`, no `LogContextFilter`).

Out-of-scope (acceptable — CLI / seed scripts, exempted by CLAUDE.md):
- `services/mock_eln/seed/{generator,fake_logs_generator}.py` use `print()` from `if __name__ == "__main__"` blocks (CLI seed).
- `services/ingestion/{eln_json_importer.legacy,doc_ingester}/cli.py` use `logging.basicConfig` from typer entrypoints (CLI tools).

**Fixed in-place:**
- `services/projectors/kg_documents/main.py` — replaced `logging.basicConfig(...)` with `configure_logging(settings.projector_log_level)`; added missing import.
- `services/projectors/kg_source_cache/main.py` — added `configure_logging(settings.projector_log_level)` to the `__main__` block; added missing import.

Status: **2 fixed in 2 files; 0 deferred.**

### DR-03 — `pool.query` on project-scoped data must run inside `withUserContext`

`rg "pool\.query\(" services/agent-claw/src --type ts | grep -v test` → 5 hits:
- `services/agent-claw/src/bootstrap/probes.ts:30,38,85` — `mcp_tools` (global catalog table; no FORCE RLS gate). OK.
- `services/agent-claw/src/tools/builtins/forge_tool.ts:179, 187, 258, 423, 446, 456` — bare `pool.query` reads/writes against `skill_library` (RLS-policy-enforced on `proposed_by_user_entra_id`) and `forged_tool_tests` (chained off skill_library). In production these will be **denied by RLS** because `app.current_user_entra_id` is never set on these connections. Tests use mocked `Pool`, so the regression is dormant in CI.

**Deferred** — fix is non-trivial (transaction restructure) and outside the "small in-file fix" scope of this sweep.

BACKLOG entry added:
```
- [agent-claw/forge_tool] DR-03 violation: services/agent-claw/src/tools/builtins/forge_tool.ts makes 4 bare pool.query writes to RLS-protected skill_library/tools tables (lines 178-191, 258, 423, 446, 456). Wrap inside a single withUserContext(pool, userEntraId, ...) transaction so production RLS doesn't reject the inserts. Tests use mocked Pool and don't exercise the RLS path
```

Status: **0 fixed; 1 deferred to BACKLOG.**

### DR-04 — Outbound MCP calls pass `userEntraId` or rely on AsyncLocalStorage RequestContext

Verified `services/agent-claw/src/mcp/postJson.ts:authHeaders()` reads from `getRequestContext()?.userEntraId` when no explicit override is supplied. All builtins use bare `postJson(...)` and inherit. Routes (`chat.ts`, `plan.ts`, `deep-research.ts`, `documents.ts`, `chained-harness.ts`) wrap their handler bodies in `runWithRequestContext({ userEntraId, ... })`.

Status: **clean.** Existing BACKLOG entry on Z-phase builtins forwarding optional `{ userEntraId }` is a test-coverage hygiene item, not a runtime bug.

### DR-05 — `SERVICE_SCOPES` parity (Python ↔ TS)

```
diff <(grep -oE "\"mcp-[a-z-]+\":" services/mcp_tools/common/scopes.py | sort -u) \
     <(grep -oE "\"mcp-[a-z-]+\":" services/agent-claw/src/security/mcp-token-cache.ts | sort -u)
```
→ no diff. 22 keys on both sides; values verified equal by inspection (e.g., `mcp-eln-local: mcp_eln:read`, `mcp-logs-sciy: mcp_instrument:read`).

Status: **clean.** Pact test (`tests/integration/test_scope_pact.py`) enforces this in CI.

### DR-06 — Projectors set `interested_event_types` OR override `_connect_and_run` with class-level docstring naming the custom NOTIFY channel

All 11 projectors (`chunk_embedder`, `compound_classifier`, `compound_fingerprinter`, `conditions_normalizer`, `contextual_chunker`, `kg_documents`, `kg_experiments`, `kg_hypotheses`, `kg_source_cache`, `qm_kg`, `reaction_vectorizer`) declare `interested_event_types`. The three that override `_connect_and_run` (`compound_classifier`, `compound_fingerprinter`, `qm_kg`) name their custom channel in module/class docstrings — verified manually.

Status: **clean.** DRIFT-I closed in PR #89.

### DR-07 — `/api/admin/*` mutations through `guardAdmin`/`requireAdmin` + `appendAudit`

All 6 admin route modules import and call `guardAdmin` (or `requireAdmin`) at handler entry. Spot-checked `admin-config.ts`, `admin-flags.ts`, `admin-permissions.ts`, `admin-redaction.ts`, `admin-users.ts`, `admin-audit.ts`. Cache-invalidation calls present where applicable.

Status: **clean.**

### DR-08 — Every `src/tools/builtins/<tool>.ts` sets `annotations: { readOnly: <bool> }`

`rg --files-without-match "annotations:" services/agent-claw/src/tools/builtins --type ts` → 3 files:
- `_qm_base.ts`, `_logs_schemas.ts`, `_eln_shared.ts` — these are shared helpers (underscore-prefixed), not registered tools. Excluded by the rule's spirit.

Every actual builtin (78 files) declares `annotations: { readOnly: <bool> }`.

Status: **clean.** DRIFT-F closed in PR #88.

### DR-09 — Tunable knobs read via `getConfigRegistry()` (TS) / `ConfigRegistry` (Py); feature gates via `feature_flags`

`rg 'process\.env\.[A-Z_]+\s*===\s*"true"' services/agent-claw/src --type ts` → 3 hits:
- `services/agent-claw/src/core/sandbox.ts:61,62` — `SANDBOX_ALLOW_NET_EGRESS`, `SANDBOX_MAX_NET_EGRESS` (sandbox toggles; bootstrap-fallback pattern is fine).
- `services/agent-claw/src/observability/user-hash.ts:45` — `CHEMCLAW_DEV_MODE` (dev-only fallback for `LOG_USER_SALT`).

These are bootstrap-fallback gates rather than tunable knobs. Existing BACKLOG entries already track migrating `MAX_ACTIVE_SKILLS`, optimizer thresholds, reanimator knobs, and per-role inference params.

Status: **clean.** No new migrations needed beyond the existing backlog.

### DR-10 — Every harness call site passes `permissions: { permissionMode: "enforce" }`

`rg "permissionMode" services/agent-claw/src/{routes,core}` → 6 production call sites all set `enforce`:
- `core/sub-agent.ts:191`
- `routes/plan.ts:115`
- `routes/deep-research.ts:177, 230`
- `core/chained-harness.ts:214`
- `routes/chat.ts:405`

These are the same 6 sites the BACKLOG entry from 2026-05-03 ("wire remaining 5 runHarness call sites with `permissionMode: 'enforce'`") flagged as missing. They're now wired.

BACKLOG entry added to retire/refresh the stale entry:
```
- [agent-claw/permissions] BACKLOG entry "wire remaining 5 runHarness call sites" is stale — sweep on 2026-05-05 confirms all 6 call sites (chat.ts, plan.ts, deep-research.ts ×2, sub-agent.ts, chained-harness.ts) pass permissionMode: 'enforce'. Update or drop the entry
```

Status: **clean.**

### DR-11 — Hook YAML / TS / `BUILTIN_REGISTRARS` parity; `MIN_EXPECTED_HOOKS` bumped on add

- `hooks/*.yaml` → 11 files (anti-fabrication, apply-skills, budget-guard, compact-window, foundation-citation-guard, init-scratch, permission, redact-secrets, session-events, source-cache, tag-maturity).
- `services/agent-claw/src/core/hooks/*.ts` → matching 11 files.
- `BUILTIN_REGISTRARS` in `core/hook-loader.ts:117-147` → 11 entries.
- `MIN_EXPECTED_HOOKS = 11` in `bootstrap/start.ts:29`.

Status: **clean.**

### DR-12 — Redaction patterns bounded; `is_pattern_safe()` enforces

`rg "\.\*[^?+]" services/litellm_redactor/redaction.py` → no unbounded `.*`. `is_pattern_safe()` defined in `dynamic_patterns.py:51` and applied at load time (line 122). DB CHECK constraint on `length(pattern_regex) <= 200` already shipped in `db/init/20_redaction_patterns.sql`.

Status: **clean.**

### DR-13 — `db/init/<NN>_<name>.sql` idempotent; one schema_version provenance pattern

Idempotency: spot-checked all 46 files use `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS` / `CREATE OR REPLACE FUNCTION` / `DROP … IF EXISTS` patterns. No raw `CREATE TABLE` without `IF NOT EXISTS`.

Provenance: only 8 of 46 files INSERT INTO `schema_version`:
- `23_qm_results.sql`, `24_compound_fingerprints.sql`, `25_compound_ontology.sql`, `26_genchem.sql`, `27_job_queue.sql`, `28_screens.sql`, `29_workflows.sql`, `32_rls_completeness.sql`.

The other 38 files don't record themselves. The CLAUDE.md guidance ("`SELECT * FROM schema_version ORDER BY filename`") implies all files should appear; the lex-order init loop apparently doesn't auto-record. **Deferred** — needs a decision (loader auto-record vs. backfill all 38 files).

BACKLOG entry added:
```
- [db/init] schema_version provenance is inconsistent: only 8 of 46 db/init/*.sql files INSERT INTO schema_version. Either populate all files (or backfill the loader to record the filename automatically) so SELECT * FROM schema_version is the canonical applied-migrations list per CLAUDE.md
```

Status: **0 fixed; 1 deferred to BACKLOG.**

### DR-14 — TS logger scrubs `err.message`/`err.stack`; Python redaction filter redacts `exc_text`

**Python — fixed in-place.** `services/mcp_tools/common/redaction_filter.py` previously had `exc_text` and `stack_info` in `_PASSTHROUGH_FIELDS`, meaning tracebacks (which regularly carry `psycopg "Failing row contains (CMP-12345, smiles=CC(=O)…)"` strings) bypassed the redactor. Removed both from passthrough, added explicit handling in `RedactionFilter.filter()`:
- Pre-materialise `record.exc_text` from `record.exc_info` (Python's logging only fills `exc_text` during `Formatter.format()`, after filters run) and run `_redact()` over the rendered traceback, then null `exc_info` so the formatter doesn't re-render and overwrite.
- Redact `record.stack_info` if present.
- Skip both keys in the generic walk so we don't double-redact.

Added regression test `test_exc_text_traceback_is_redacted` in `services/mcp_tools/common/tests/test_redaction_filter.py`. All 8 tests pass; full common test suite: 87 passed.

**TS — deferred.** `services/agent-claw/src/observability/logger.ts:48-73` ROOT_REDACT_PATHS still deliberately omits `err.message`/`err.stack`. The comment block (lines 62-70) is honest about the gap. CLAUDE.md "Logging" section explicitly tracks this as a known issue. Fix requires a Pino serializer wired through the logger config plus relocating `redactString` from `core/hooks/redact-secrets.ts` to a leaf util (the hook currently imports types from `core/types.ts` — moving the helper avoids the circular hook→logger import).

BACKLOG entry added:
```
- [agent-claw/observability] DR-14 mirror on TS: services/agent-claw/src/observability/logger.ts ROOT_REDACT_PATHS deliberately omits err.message/err.stack (acknowledged in 2026-05-03/04-security.md F-8). Add a Pino serializer that runs redactString from core/hooks/redact-secrets.ts over those fields; mind the cross-cutting import (consider extracting redactString to a leaf util to avoid hook→logger circular dep)
```

`LOG_USER_SALT` requirement: verified — `observability/logger.ts` and `observability/user-hash.ts` enforce a non-default salt outside dev mode.

Status: **1 fixed (Python) in 2 files (1 source + 1 test); 1 deferred (TS) to BACKLOG.**

### DR-15 — Project-scoped tables have ENABLE+FORCE RLS + at least one policy

`db/init/32_rls_completeness.sql` (PR-87 baseline) closes the workflow / task_queue / qm_* / user_project_access gaps. Spot-checked: 32 RLS-applied tables, all carry both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.

Status: **clean.**

## What I fixed (in-place)

| File | Rule | Change |
|---|---|---|
| `services/projectors/kg_documents/main.py` | DR-02 | Replaced `logging.basicConfig(...)` with `configure_logging(settings.projector_log_level)`; added import. |
| `services/projectors/kg_source_cache/main.py` | DR-02 | Added `configure_logging(settings.projector_log_level)` to `__main__`; added import. |
| `services/mcp_tools/common/redaction_filter.py` | DR-14 (Py) | Removed `exc_text`, `stack_info` from `_PASSTHROUGH_FIELDS`; added explicit `_redact()` over `exc_info`/`exc_text`/`stack_info` in `RedactionFilter.filter()`; null `exc_info` after pre-materialising to avoid formatter overwrite. |
| `services/mcp_tools/common/tests/test_redaction_filter.py` | DR-14 (Py) | New regression test `test_exc_text_traceback_is_redacted`. |
| `BACKLOG.md` | (deferrals) | 4 new entries — see below. |

## What I deferred (BACKLOG additions)

```
- [agent-claw/forge_tool] DR-03 violation: services/agent-claw/src/tools/builtins/forge_tool.ts makes 4 bare pool.query writes to RLS-protected skill_library/tools tables (lines 178-191, 258, 423, 446, 456). Wrap inside a single withUserContext(pool, userEntraId, ...) transaction so production RLS doesn't reject the inserts. Tests use mocked Pool and don't exercise the RLS path
- [agent-claw/observability] DR-14 mirror on TS: services/agent-claw/src/observability/logger.ts ROOT_REDACT_PATHS deliberately omits err.message/err.stack (acknowledged in 2026-05-03/04-security.md F-8). Add a Pino serializer that runs redactString from core/hooks/redact-secrets.ts over those fields; mind the cross-cutting import (consider extracting redactString to a leaf util to avoid hook→logger circular dep)
- [db/init] schema_version provenance is inconsistent: only 8 of 46 db/init/*.sql files INSERT INTO schema_version. Either populate all files (or backfill the loader to record the filename automatically) so SELECT * FROM schema_version is the canonical applied-migrations list per CLAUDE.md
- [agent-claw/permissions] BACKLOG entry "wire remaining 5 runHarness call sites" is stale — sweep on 2026-05-05 confirms all 6 call sites (chat.ts, plan.ts, deep-research.ts ×2, sub-agent.ts, chained-harness.ts) pass permissionMode: 'enforce'. Update or drop the entry
```

## Cross-cutting drifts (queued for Tier 2-4)

1. **Python services that own their own logger config but don't call `configure_logging()`.** Surfaced two today (kg_source_cache, kg_documents) — both fixed. A general "every service entrypoint runs `configure_logging`" lint would catch future regressions. Tier 2 candidate: a unit test that imports each `main.py` and asserts the root logger has the JSON formatter installed.

2. **Bare `pool.query` outside `withUserContext`.** `forge_tool.ts` is the loud case but the pattern (cache-by-pool, RLS-by-user-context) is fragile across the codebase. A targeted lint rule (or static-analysis pass in CI) that flags `pool.query(` outside a `withUserContext` / `withSystemContext` / annotated-global context would prevent the next regression. Worth pairing with a "global tables are explicit" allowlist.

3. **Schema-version provenance fragmentation.** Most `db/init/*.sql` files don't self-record. A single-source decision (auto-record in `make db.init` vs. require every file to INSERT) is overdue and would also enable a real migration tool — already on BACKLOG as a separate item.

4. **TS-side traceback redaction.** Mirror of the Python fix above. The `redact-secrets.ts` helper already exists; the move-to-leaf-util refactor is the blocker.

## Verification

```
$ python3 -m py_compile services/projectors/kg_documents/main.py \
                       services/projectors/kg_source_cache/main.py \
                       services/mcp_tools/common/redaction_filter.py \
                       services/mcp_tools/common/tests/test_redaction_filter.py
OK

$ .venv/bin/python -m pytest services/mcp_tools/common/tests/ -q
87 passed in 2.87s

$ cd services/agent-claw && npx tsc --noEmit
(clean — no output)
```
