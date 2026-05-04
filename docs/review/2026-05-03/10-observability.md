# Observability & Logging Audit — 2026-05-03

**Reviewer:** observability-and-logging (read-only)
**Working tree:** `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw`
**Branch:** `main` @ `4b1c949`
**Cross-references:** Wave 1 reports
[`05-agent-claw-ts.md`](05-agent-claw-ts.md),
[`06-mcp-python.md`](06-mcp-python.md),
[`07-projectors-ingestion.md`](07-projectors-ingestion.md),
[`04-security.md`](04-security.md).

---

## Executive Summary

The centralised-logging contract from CLAUDE.md is *substantially* in
place: zero `console.*` survivors in `services/agent-claw/src/`,
`getLogger`/`configure_logging` adopted by every long-running service
the audit checked except the four flagged below, the LiteLLM redactor
runs over every Python log record, the Pino root logger has a defensive
redact list, and a real correlation pipeline (TS `RequestContext` ALS
→ `x-request-id` header → Python `add_request_id` middleware →
`LogContextFilter` contextvar → JSON `request_id` field) carries a
single id from the agent-claw HTTP boundary all the way into MCP service
log lines. `LOG_USER_SALT` is fail-closed on both sides; the Python
side has one carve-out that needs tightening
(`PYTEST_CURRENT_TEST` recognised as dev — already flagged P1 in the
security audit).

What does NOT hold breaks down into seven concrete defects, ordered by
operator impact:

1. **Grafana ↔ Promtail label mismatch** — every projector dashboard
   panel queries `{service=~"projector-.+"}` but Promtail strips
   `chemclaw-` from container names producing `kg-experiments`,
   `kg-hypotheses`, `chunk-embedder`, etc. with no `projector-`
   prefix. Five of the six panels in `projectors.json` are silently
   empty in production. Only `session-reanimator` / `session-purger`
   (which happen to start with `session-`) match.
2. **Six writer/runner services don't go through `configure_logging`**
   (`kg_hypotheses`, `kg_source_cache`, `session_purger`,
   `session_reanimator`, `gepa_runner.runner`, `skill_promoter.runner`,
   `forged_tool_validator.runner`, `eln_json_importer.legacy.cli`). They
   either call `logging.basicConfig(...)` or never configure a handler
   at all, so their log output is unstructured and bypasses the
   `LogContextFilter` + `RedactionFilter`. Every one is on a
   load-bearing operational path. CLAUDE.md violation, surfaced in
   W1.7 for the two projectors; here we add the four optimizer /
   reanimator instances.
3. **Langfuse / OTel root spans only fire on the `/api/chat` SSE
   path.** `startRootTurnSpan` is called from exactly one site
   (`routes/chat.ts:258`). Non-streaming chat, plan-approve,
   `/api/sessions/:id/plan/run`, `/api/sessions/:id/resume`,
   `/api/internal/sessions/:id/resume`, `/api/deep_research`, and
   sub-agents all execute the harness without opening a turn span.
   `withToolSpan` still wraps the per-tool path, but those spans are
   parent-less in any non-streaming flow and Langfuse renders them as
   orphan single-call traces with no `prompt:agent.system` tag
   (defeating the GEPA tag-filter fetch).
4. **`request_id` correlation through projectors is dead** — already
   surfaced in W1.7. The `LoggerAdapter` in
   `services/projectors/common/base.py:296-302` reads
   `payload.get("request_id")` from `ingestion_events.payload`, but the
   three writers (`source-cache.ts:370-378`, `propose_hypothesis.ts:99-107`,
   `doc_ingester/importer.py:144-151`) all emit payloads without it, so
   every projector log line falls back to the event_id and the
   cross-boundary trace stops at the canonical INSERT.
5. **`record_error_event(...)` has zero callers.** The function is
   defined in `db/init/19_observability.sql:138-199`, is granted to
   `chemclaw_app` and `chemclaw_service`, has its own `error_events`
   table, indexes, RLS policies, NOTIFY trigger — and not a single TS
   or Python file actually calls it. `error_events` is never written.
   The references in `errors/codes.ts:3` and `errors/envelope.ts:17`
   describe an intended sink that was never wired.
6. **Pino redact list is path-based and misses `err.message` /
   `err.stack`.** The logger.ts comment is honest: "We deliberately do
   NOT redact `err.message` / `err.stack`." Postgres and `UpstreamError`
   error strings reliably embed SMILES, compound codes, and project
   ids ("invalid input syntax for type … near 'CMP-…'", "Failing row
   contains (…)"). This is W1.4 P2 carried forward. The Python side
   has the same pattern: `RedactionFilter._PASSTHROUGH_FIELDS`
   includes `exc_info` and `exc_text`, so a raised Postgres exception
   bypasses redaction in JSON output. Both sides need a content-aware
   pass that mirrors the LiteLLM regex-based filter.
7. **`appendAudit` not called from the four legacy admin-gated routes
   (`eval`, `optimizer`, `skills`, `forged-tools`).** They mutate state
   (run evaluation jobs, enable/disable skills, change scope on forged
   tools, kick off optimizer runs) but never write to `admin_audit_log`.
   CLAUDE.md mandates audit on every state-changing admin branch.

The systemic message is: the *infrastructure* is in place — JSON
logging, redaction filters, Pino mixins, OTel SDK, Loki/Grafana
provisioning, audit log table — but the *adoption* lags. Several of
these defects appear to date from before the Wave 1 audits and just
weren't yet on anyone's checklist; others (the Grafana label mismatch)
are silent operator failures that won't surface until someone tries to
investigate a projector incident.

The full counts: 0 `console.*` in TS production code, 7 production
`print()` only in scripts/seeders/vendored (whitelisted), 22 of 23 MCP
services use `create_app` → `configure_logging` (none deviate), 18
TS modules use `getLogger` and the only fastify-bound `app.log.*`
emitters are correctly inside `bootstrap/probes.ts` + `bootstrap/start.ts`,
0 f-string / template-literal log calls (every Python log uses
`%s` / `%d` placeholders, every TS log uses the `({fields}, "msg")`
shape).

---

## Service-level Logging Adoption Matrix

### Python long-running services

| Service | uses `configure_logging` | uses `getLogger(name)` | print() offenders |
| --- | --- | --- | --- |
| `mcp_aizynth/main.py` … `mcp_yield_baseline/main.py` (22 MCPs) | yes (via `create_app`) | yes | none |
| `services/projectors/chunk_embedder/main.py` | yes | yes | none |
| `services/projectors/compound_classifier/main.py` | yes | yes | none |
| `services/projectors/compound_fingerprinter/main.py` | yes | yes | none |
| `services/projectors/conditions_normalizer/main.py` | yes | yes | none |
| `services/projectors/contextual_chunker/main.py` | yes | yes | none |
| `services/projectors/kg_experiments/main.py` | yes | yes | none |
| `services/projectors/kg_hypotheses/main.py` | **NO — `logging.basicConfig` line 167** | yes (`"kg-hypotheses"` — hyphen, also flagged in W1.7) | none |
| `services/projectors/kg_source_cache/main.py` | **NO — never configured** (line 30 `getLogger` only) | yes | none |
| `services/projectors/qm_kg/main.py` | yes | yes | none |
| `services/projectors/reaction_vectorizer/main.py` | yes | yes | none |
| `services/queue/worker.py` | yes (line 317) | yes | none |
| `services/workflow_engine/main.py` | yes (line 316) | yes | none |
| `services/optimizer/session_purger/main.py` | **NO — `logging.basicConfig` line 114** | yes | none |
| `services/optimizer/session_reanimator/main.py` | **NO — `logging.basicConfig` line 222** | yes | none |
| `services/optimizer/gepa_runner/runner.py` | **NO — `logging.basicConfig(level=logging.INFO)` line 361** | yes | none |
| `services/optimizer/skill_promoter/runner.py` | **NO — `logging.basicConfig(level=logging.INFO)` line 103** | yes | none |
| `services/optimizer/forged_tool_validator/runner.py` | **NO — `logging.basicConfig(level=logging.INFO)` line 225** | yes | none |
| `services/ingestion/doc_ingester/cli.py` | yes | yes | none |
| `services/ingestion/eln_json_importer.legacy/cli.py` | **NO — `logging.basicConfig`** (legacy package, target broken per W1.7 anyway) | yes | none |

### Python scripts / seed / vendored — whitelisted

| File | print() count | Reason |
|---|---|---|
| `services/optimizer/scripts/seed_golden_set.py` | 7 | One-shot CLI; output is intended for the operator's terminal |
| `services/mcp_tools/mcp_yield_baseline/scripts/eval_doyle.py` | 4 | Same |
| `services/mcp_tools/mcp_applicability_domain/scripts/build_drfp_stats.py` | 6 | Same |
| `services/mock_eln/seed/generator.py` | 1 | Seeder that prints summary table |
| `services/mock_eln/seed/fake_logs_generator.py` | 1 | Same |
| `services/mcp_tools/mcp_synthegy_mech/vendored/molecule_set.py` | 4 | **Vendored** from `github.com/schwallergroup/steer`; carry upstream behaviour |
| `services/agent-claw/src/tools/builtins/run_program.ts:231` | (embedded) | `print(...)` is inside the *embedded Python program template* the sandbox runs — not host code |
| `services/optimizer/forged_tool_validator/validator.py:138` | (embedded) | Same — inside generated f-string for sandbox program |

### TypeScript — agent-claw

`grep -nE "console\.(log|warn|error|info|debug)" services/agent-claw/src/` returns **zero** hits. The single match in `services/agent-claw/scripts/forged-tool-ci-check.ts:133-158` is in a CI script, not a service module, and is whitelist-able (operator-facing CLI output). The single comment match in `src/observability/logger.ts:11` is the historical-context comment in the file header.

| Module group | `getLogger` adopted | `app.log.*` (Fastify Pino) | Comment |
| --- | --- | --- | --- |
| `src/bootstrap/probes.ts`, `src/bootstrap/start.ts` | — | yes | Correct — these run inside Fastify's logger lifecycle |
| `src/observability/{logger,with-retry,log-context}.ts` | yes | — | |
| `src/core/{lifecycle,sandbox,step}.ts` | yes | — | |
| `src/tools/registry.ts`, `src/tools/builtins/{run_chemspace_screen,find_similar_compounds,match_smarts_catalog,substructure_search,classify_compound,synthesize_insights,promote_workflow_to_tool,enqueue_batch}.ts` | yes | — | All structured `log.warn({err}, "msg")` form |
| `src/db/{qm-cache,with-user-context}.ts` | yes | — | |
| `src/streaming/sse.ts`, `src/config.ts` | yes | — | |
| `src/core/chained-harness.ts` | yes (`log.warn({err}, "...")`) | — | |
| Paperclip (`services/paperclip/src/index.ts`) | uses Fastify-bound Pino directly (`Fastify({ logger: true })`) | yes | Acceptable — paperclip is a single-file process |

No grep hit found for `app.log.*` outside `bootstrap/`, no template-literal interpolation in any log call.

---

## Format-String Injection Findings

CLAUDE.md mandates "never concatenate user input into the message format string — pass values as fields/args".

**Python** — searched `services/ -name '*.py'` for `\.(info|warn|error|debug|warning|exception)\(f["']` and `\.(...)\([^,]*\$\{`. **Zero hits.** Every Python log call examined uses `%s`/`%d` placeholders or `extra={...}`. Examples:

```py
# services/ingestion/doc_ingester/importer.py:179
log.warning("ingest failed for %s: %s", path, exc)

# services/optimizer/session_reanimator/main.py:201
log.error("failed to mint resume token for session %s: %s", session_id, exc)
```

**TypeScript** — searched for `(log|logger)\.(info|warn|error|debug)\(\``  in `services/agent-claw/src/`. **Zero hits.** Every TS log call uses the canonical Pino shape:

```ts
// services/agent-claw/src/core/chained-harness.ts:158
log.warn({ err }, "paperclip /reserve failed in chained-harness (non-fatal)");

// services/agent-claw/src/bootstrap/probes.ts:91
app.log.debug({ tool: row.service_name, status: newStatus }, "mcp-probe: updated");
```

This finding is **clean**.

---

## Pino / JSON-formatter redaction completeness

### Pino root redact list (`src/observability/logger.ts:48-73`)

```ts
const ROOT_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.authorization",
  "*.cookie",
  "*.password",
  "*.token",
  "*.api_key",
  "*.apiKey",
  "tool_input.smiles",
  "tool_output.smiles",
  "messages[*].content",
  "prompt",
  "raw_user",
  "err.detail",
  "*.detail",
];
```

CLAUDE.md (line 277) lists `authorization / cookie / err.message / err.stack / detail`. The implementation **deliberately omits** `err.message` and `err.stack` (line 64-69 comment is explicit about it). The doc/code mismatch is also called out in [`05-agent-claw-ts.md` Low item, line 46]; CLAUDE.md should be updated to match the code.

The omission *is* a real risk per the security audit's W1.4 P2 finding. Two reliable carriers of chemistry-sensitive content slip through:

* **Postgres driver errors** — `node-postgres` `DatabaseError.message` follows `error: invalid input syntax for type uuid: "CMP-1234:abcd"` and `Failing row contains (uuid_col, smiles_col, ...)` — the column values land in the message verbatim.
* **`UpstreamError`** — constructed at `mcp/postJson.ts:16-23` as `new UpstreamError(service, status, text.slice(0, 200))`. The 200-char detail slice IS scrubbed by Pino's path-redact (`*.detail`), but `err.message` (which `UpstreamError` builds as `${service} returned ${status}: ${detail}`) is NOT — so the same body content reappears in the `err.message` field that bypasses redaction.

**Recommendation — additions to `ROOT_REDACT_PATHS`:**

```ts
// Add a Pino serializer that runs the LiteLLM-style regex over err.message
// + err.stack — the path-based redact can't do content-aware scrubbing.
// Mirror src/observability/redactor.ts (TBD) on the Python side.
serializers: {
  err: pinoStdSerializers.err,  // includes message + stack
}
// + a custom formatter that calls the redactor on message strings.
```

A simpler additive list of paths catches *some* of the Postgres-error
shapes (`*.message` would cover both), at the cost of potentially
hiding diagnostic lines from operators triaging an MCP outage:

```ts
"*.message",     // catches DatabaseError.message, UpstreamError.message
"*.stack",       // catches the embedded line "Failing row contains (...)"
"*.where",       // node-postgres includes the SQL fragment that failed
```

The right fix is the content-aware redactor mirroring the Python side,
not more path entries.

**Field-level adds based on this codebase's actual leak surface:**

```ts
"*.compound_code",   // CMP-XXXX always sensitive
"*.nce_id",
"*.project_id",      // when populated from app code
"*.smiles",          // currently only tool_input.smiles / tool_output.smiles
"*.smarts",
"*.reaction_smiles",
"*.inchi",
"*.inchikey",
"*.cas",
"*.entra_id",        // raw entra ids in any non-userHash field
"*.email",
```

I checked one example log call per route; no smoking-gun raw-SMILES
emit was found, but the path-list is structural-only and only protects
fields with the *exact* path. A typo (`tool.input.smiles`) silently
fails open.

### Python `RedactionFilter` (`services/mcp_tools/common/redaction_filter.py`)

The filter runs `redact()` over `record.getMessage()` and every extra
field except `_PASSTHROUGH_FIELDS`. The pass-through set excludes
`exc_info` / `exc_text` (lines 63-64). Per W1.4 P2: a Postgres
exception with SMILES in the message bypasses the redactor when the
formatter renders `exc_text`. Verified — the `_PASSTHROUGH_FIELDS`
frozen-set explicitly contains `"exc_info"` and `"exc_text"`.

**Status:** P0/P1 risk per the security audit. Recommended fix is to
override `Formatter.formatException` so the redactor runs over the
post-formatted exception text, OR drop `exc_info`/`exc_text` from the
pass-through set (which would require patching the JSON formatter to
re-render them after redaction). The minimal-diff fix — wrap the
existing redactor over the formatted exception string in a custom
formatter subclass — is straightforward.

---

## Trace-ID Propagation Map

| Path | Origin → MCP → Projector | Continuous? |
| --- | --- | --- |
| `POST /api/chat` (SSE streaming) | Fastify `req.id` → `runWithRequestContext({requestId})` (chat.ts:581) → `correlationHeaders()` in postJson (postJson.ts:57-64) → MCP `add_request_id` middleware (common/app.py:296) → `bind_log_context(request_id=rid)` → `LogContextFilter` stamps every record | **YES** |
| `POST /api/chat` (non-streaming) | Same as above — handleNonStreamingTurn is invoked from inside the chat.ts ALS wrapper | **YES** |
| `POST /api/chat/plan/approve` | `runWithRequestContext` wired (plan.ts:96) | **YES** |
| `POST /api/sessions/:id/plan/run` | `runChainedHarness` opens its own `runWithRequestContext` (chained-harness.ts:93) | **YES** |
| `POST /api/sessions/:id/resume` | Same — via `runChainedHarness` | **YES** |
| `POST /api/internal/sessions/:id/resume` | Same — via `runChainedHarness` | **YES** |
| `POST /api/deep_research` | `runWithRequestContext` wired (deep-research.ts:306) | **YES** |
| Sub-agent (`core/sub-agent.ts`) | Inherits parent ALS context (sub-agent runs from inside parent's harness loop) | **YES** |
| `session_reanimator` → `/api/internal/sessions/:id/resume` | Mints a fresh `request_id = str(uuid.uuid4())` and sends `x-request-id: ...` header (`session_reanimator/main.py:185-186`) | **YES** (origin is reanimator, not a user request) |
| Canonical INSERT → `ingestion_events.payload` → projector | Writers (`source-cache.ts:370-378`, `propose_hypothesis.ts:99-107`, `doc_ingester/importer.py:144-151`) DO NOT include `request_id` in the JSONB payload | **NO — DEAD per W1.7** |
| Tool span → child span | OTel ALS context manager wired (`otel.ts:92-94`); `withToolSpan` creates spans whose parent is `startActiveSpan` of the ambient context | **YES** when a parent span exists; **NO parent** for chained / plan / deep-research / non-streaming chat / sub-agent (see "OTel coverage" below) |

**Findings:**

- Every TS HTTP route that calls the harness wraps in
  `runWithRequestContext`. The ALS context propagates the
  `x-request-id` and `x-session-id` headers via
  `correlationHeaders()` in `postJson` / `getJson`. Every MCP
  service receives both headers, validates the session id (UUID
  shape), and binds them onto its `LogContext` via
  `bind_log_context`. The full chain works.
- The projector dead-correlation is not a TS/Python infrastructure
  bug — the writers just need to stop dropping the field. A 4-line
  fix per writer:

  ```ts
  // source-cache.ts — read from RequestContext
  const ctx = getRequestContext();
  const payload = { ...fact, request_id: ctx?.requestId };
  ```

  ```py
  # doc_ingester/importer.py — accept a request_id arg from the caller
  Jsonb({"sha256": sha, "chunk_count": ..., "request_id": request_id})
  ```

---

## /readyz Quality Scorecard

Methodology: read each service's `_is_ready()` / `_ready_check()` body
and rate against the W1.6 GOOD/MEDIUM/WEAK/MISSING criteria.

### MCP services (Python)

| Service | Rating | Evidence |
| --- | --- | --- |
| `mcp_aizynth` | **WEAK** | `return _CONFIG_PATH.exists()` (file existence only) |
| `mcp_applicability_domain` | **MEDIUM** | `return _STATS is not None` (loaded artifact in memory) |
| `mcp_askcos` | **WEAK** | `return _MODEL_DIR.exists() and _MODEL_DIR.is_dir()` |
| `mcp_chemprop` | **WEAK** | `return _MODEL_DIR.exists() and _MODEL_DIR.is_dir()` |
| `mcp_crest` | **MEDIUM** | `return shutil.which("crest") is not None` (binary in PATH) |
| `mcp_doc_fetcher` | **MISSING** | No `ready_check` passed; default returns `{status: "ok"}` always |
| `mcp_drfp` | **MISSING** | No `ready_check` |
| `mcp_eln_local` | **WEAK** | `return bool(settings.mock_eln_enabled)` — feature flag only, doesn't probe pool. The ELN service has a Postgres dependency that the readyz misses. |
| `mcp_embedder` | **WEAK** | `return _encoder is not None` — comment explicitly notes the model download is intentionally NOT blocked (so readyz flips green before the encoder can actually serve) |
| `mcp_genchem` | **MEDIUM** | imports `rdkit`; no DB probe (the service does connect to Postgres at request time) |
| `mcp_green_chemistry` | **WEAK** | `return _DATA_DIR.exists() and _DATA_DIR.is_dir()` |
| `mcp_kg` | **GOOD** | `await _driver().verify()` — actually pings Neo4j (best of the fleet) |
| `mcp_logs_sciy` | **MEDIUM** | reads `_health_holder.get("healthy")` populated at lifespan startup; doesn't probe per-request |
| `mcp_ord_io` | **MEDIUM** | `return _ord_schema_loadable()` — checks the imports work |
| `mcp_plate_designer` | **WEAK** | `return (_DATA_DIR / "chem21_solvents_v1.json").exists()` |
| `mcp_rdkit` | **MISSING** | No `ready_check` |
| `mcp_reaction_optimizer` | **MEDIUM** | imports `bofire` — at least proves the dep is present |
| `mcp_sirius` | **MEDIUM** | `shutil.which("sirius") is not None` |
| `mcp_synthegy_mech` | **MEDIUM** | imports RDKit + tries to build a stub policy; comment correctly notes LiteLLM probe is deliberately skipped |
| `mcp_tabicl` | **WEAK** | `return pca_path.exists()` |
| `mcp_xtb` | **MEDIUM** | `xtb_available()` — binary in PATH |
| `mcp_yield_baseline` | **MEDIUM** | `return _GLOBAL_XGB_MODEL is not None` |

**Distribution:** GOOD 1, MEDIUM 10, WEAK 8, MISSING 3 (out of 22 in-scope MCPs). This matches W1.6's verdict — most readyz are cosmetic. A `chemprop` model could be missing from `_MODEL_DIR` and the service would still flap green.

### Agent-claw + Paperclip

| Service | Rating | Evidence |
| --- | --- | --- |
| `agent-claw` `/readyz` (`bootstrap/probes.ts:26-55`) | **GOOD** | Probes Postgres + checks at least one mcp_tools row is healthy. Returns typed `reason` on degradation. |
| `agent-claw` `/healthz` (registered in `routes/healthz.ts`) | not inspected here; W1.5 covered |
| `paperclip-lite` | not inspected — single-file Fastify; W1.5 covered |
| `workflow_engine` | **MISSING** | No HTTP server (poll worker) — readyz N/A; container relies on liveness via process supervisor |
| `queue/worker.py` | **MISSING** | Same — poll worker |

**One concrete production caveat** for agent-claw `/readyz`: the
M-severity finding in W1.5 calls out that the probe loop's first
invocation is delayed by `MCP_HEALTH_PROBE_INTERVAL_MS` (60 s), so
`/readyz` returns `no_healthy_mcp_tools` for up to 60 s on a fresh
start. K8s `readinessProbe.failureThreshold` will mark the pod
not-ready until the first probe lands.

---

## Audit-Log Coverage Matrix

| Admin route | Mutates? | Calls `appendAudit`? | Evidence |
| --- | --- | --- | --- |
| `/api/admin/config/*` (PATCH/DELETE) | yes | **yes** | admin-config.ts:167, 230 |
| `/api/admin/feature-flags/*` (POST/DELETE) | yes | **yes** | admin-flags.ts:111, 148 |
| `/api/admin/permission-policies/*` (POST/PATCH/DELETE) | yes | **yes** | admin-permissions.ts:135, 184, 226 |
| `/api/admin/redaction-patterns/*` (POST/PATCH/DELETE) | yes | **yes** | admin-redaction.ts:126, 162, 190 |
| `/api/admin/users/*` (POST/DELETE) | yes | **yes** | admin-users.ts:104, 151 |
| `/api/admin/audit` (GET) | no | n/a | read-only |
| `POST /api/forged-tools/:id/scope` | yes — promotes scope | **NO** | forged-tools.ts:161 (no appendAudit anywhere in this file) |
| `POST /api/forged-tools/:id/disable` | yes — disables a forged tool | **NO** | forged-tools.ts:208 |
| `POST /api/skills/enable` | yes — toggles a global skill | **NO** | skills.ts:55 (custom `requireAdmin` on `user_project_access`, no audit) |
| `POST /api/skills/disable` | yes | **NO** | skills.ts:79 |
| `POST /api/eval` | yes — kicks off eval run, mutates `eval_runs` | **NO** | eval.ts:99 (custom `requireAdminEval`, no audit) |
| `POST /api/optimizer/*` | yes — mutates optimizer state | **NO** | optimizer.ts (no appendAudit at all) |
| `POST /api/feedback` | yes — inserts `feedback_events` | **NO** | feedback.ts (not admin-gated, but mutating; W1.5 noted insertFeedback inconsistency) |

**Tool builtins that DO call `appendAudit`** (verified): `workflow_define`, `workflow_run`, `workflow_modify`, `workflow_pause_resume`, `workflow_replay`, `promote_workflow_to_tool`, `enqueue_batch`. Good — the workflow surface follows the contract.

**The pattern**: the four routes in `services/agent-claw/src/routes/` that *predate* the `routes/admin/*` consolidation (W1.5 High item: three duplicate `requireAdmin`s on `user_project_access.role`) ALSO bypass `appendAudit`. The fix recommended in W1.5 — collapse the duplicates onto `guardAdmin` from `middleware/require-admin.ts` — should be paired with adding `appendAudit` calls.

---

## Findings (Full Appendix)

### F-1 [HIGH] Grafana projector dashboards query a `service` label that Promtail never produces

* **Files:**
  - `infra/grafana/provisioning/dashboards/projectors.json` (5 panels query `{service=~"projector-.+"}`)
  - `infra/promtail/promtail-config.yaml:51-54` (relabel rule strips `chemclaw-` prefix)
  - `docker-compose.yml:182,242,270,299,390,416,442,470,498,1408` (projector container names)
* **Evidence:**
  ```yaml
  # promtail-config.yaml:50-54
  - source_labels: ["__meta_docker_container_name"]
    regex: "/?chemclaw-(.+)"
    target_label: service
  ```
  Container `chemclaw-kg-experiments` → label `service="kg-experiments"`. Likewise `chemclaw-reaction-vectorizer` → `reaction-vectorizer`, `chemclaw-chunk-embedder` → `chunk-embedder`, `chemclaw-kg-hypotheses` → `kg-hypotheses`, `chemclaw-kg-source-cache` → `kg-source-cache`.
  ```json
  // projectors.json
  "expr": "sum by (projector) (count_over_time({service=~\"projector-.+\"} ...))"
  ```
  Five of six panels in `projectors.json` filter for `projector-.+`. None match anything in production.
* **Fix sketch:** either rename containers to `chemclaw-projector-kg-experiments` (touches docker-compose plus K8s manifests) OR change the dashboard regex to a pipe of explicit names: `{service=~"kg-experiments|kg-hypotheses|kg-source-cache|chunk-embedder|reaction-vectorizer|conditions-normalizer|contextual-chunker|compound-classifier|compound-fingerprinter|qm-kg"}`. The latter is the smaller diff. The former is cleaner long-term — `service=~"projector-.+"` is the documented intent (see `promtail-config.yaml:9-13` comment listing the projector services).
* **Verification:** `docker compose --profile observability up -d` then in Grafana run the panel query manually; it returns no data. Alternatively `logcli` or `curl http://loki:3100/loki/api/v1/labels/service/values` and confirm no `projector-*` value exists.

### F-2 [HIGH] Six services don't go through `configure_logging`; output is unstructured and bypasses redaction

* **Files:**
  - `services/projectors/kg_hypotheses/main.py:167` — `logging.basicConfig(level=settings.projector_log_level)` (W1.7 M)
  - `services/projectors/kg_source_cache/main.py:30` — never configures any handler (W1.7 M)
  - `services/optimizer/session_purger/main.py:114` — `logging.basicConfig(level=settings.log_level)`
  - `services/optimizer/session_reanimator/main.py:222` — `logging.basicConfig(level=settings.log_level)`
  - `services/optimizer/gepa_runner/runner.py:361` — `logging.basicConfig(level=logging.INFO)`
  - `services/optimizer/skill_promoter/runner.py:103` — `logging.basicConfig(level=logging.INFO)`
  - `services/optimizer/forged_tool_validator/runner.py:225` — `logging.basicConfig(level=logging.INFO)`
  - `services/ingestion/eln_json_importer.legacy/cli.py` — `logging.basicConfig` (legacy path; W1.7 says it's import-broken anyway, so secondary)
* **Evidence:** the six services emit plain text rather than JSON, so `LogContextFilter` (request_id, session_id, user) and `RedactionFilter` (LiteLLM-backed scrubbing) never run. Promtail's `pipeline_stages.json` step then fails for each line and the JSON-keyed dashboards lose that source. CLAUDE.md "Logging" section (line 277) is explicit: structured logging is required.
* **Fix sketch (uniform):**
  ```py
  from services.mcp_tools.common.logging import configure_logging
  ...
  async def amain() -> None:
      settings = Settings()
      configure_logging(settings.log_level, service="<service_name>")
      ...
  ```
* **Verification:** start the service with `LOG_FORMAT=json`; tail stdout; assert each line parses as JSON and includes `service`/`request_id`/`level` keys. The unit test under `services/mcp_tools/common/tests/test_logging_json.py` already proves the formatter does the right thing — the failing services just don't invoke it.

### F-3 [HIGH] Langfuse / OTel root spans only fire on `/api/chat` SSE — every other harness path produces orphan tool spans

* **Files (call sites that should open a root span but don't):**
  - `services/agent-claw/src/routes/chat-non-streaming.ts:120` (calls `agent.run` inside `otelContext.with(rootSpan, ...)` — but `rootSpan` is constructed by the caller `chat.ts`, this path is fine via that caller)
  - `services/agent-claw/src/routes/plan.ts:96` (no `startRootTurnSpan`)
  - `services/agent-claw/src/routes/deep-research.ts:306` (no `startRootTurnSpan`)
  - `services/agent-claw/src/routes/sessions-handlers.ts:169,278` (no `startRootTurnSpan`)
  - `services/agent-claw/src/core/chained-harness.ts:90+` (loops many runHarness calls; no per-iteration span)
  - `services/agent-claw/src/core/sub-agent.ts` (no span)
* **Evidence:**
  ```bash
  $ grep -nE "startRootTurnSpan|tracer.startSpan" services/agent-claw/src/{routes,core}/*.ts
  services/agent-claw/src/routes/chat.ts:42:import { startRootTurnSpan, ...
  services/agent-claw/src/routes/chat.ts:258:  const rootSpan = startRootTurnSpan({
  ```
  Single call site. `withToolSpan` (`tool-spans.ts:38`) opens a child via `tracer.startActiveSpan` — when the ambient context has no parent span, the child IS the trace root. Langfuse renders it as a single-call orphan. The `prompt:agent.system` tag set on `startRootTurnSpan` (used by GEPA's `fetch_traces(tags=...)`) never lands for chained / plan / deep-research / non-streaming traces.
* **Impact:** GEPA's prompt-optimizer cycle sees only streaming `/api/chat` traces. Sub-agent and deep-research turns — where the highest-cost reasoning happens — are invisible. The `langfuse.session.id` attribute that lets the UI thread multi-turn sessions is also missing for chained execution.
* **Fix sketch:** Hoist `startRootTurnSpan` into a helper that every harness-invoking route calls. The helper should accept `traceId, userEntraId, model, sessionId, promptName, promptVersion`. Pair this with W1.5 PARITY-1 (`permissions: { permissionMode: "enforce" }` only on one path) — both are "the streaming-chat route is special, every other path silently skips a thing" defects.
* **Python side:** No MCP service emits OTel spans (`grep -rln "opentelemetry" services/mcp_tools/` returns 1 hit, and that's `error_envelope.py` only *reading* `trace_id` from an active span if one exists — none are created in Python). So Langfuse can't see "tool execution time on the MCP service side" — only the agent-claw-side roundtrip duration. This may be acceptable (the agent-side `withToolSpan` captures the roundtrip), but it's worth noting that the MCP services are observability-dark.

### F-4 [HIGH] `request_id` correlation through projectors is dead

W1.7 covered this. Confirmed for this audit:

* **Reader:** `services/projectors/common/base.py:296-302` reads `request_id = payload.get("request_id")` and binds onto a LoggerAdapter.
* **Writers (none of which include request_id):**
  - `services/agent-claw/src/core/hooks/source-cache.ts:370-378` — payload is `JSON.stringify(fact)` only
  - `services/agent-claw/src/tools/builtins/propose_hypothesis.ts:99-107` — payload is `{ hypothesis_id }` only
  - `services/ingestion/doc_ingester/importer.py:144-151` — payload is `{sha256, chunk_count, source_type}` only
* **Fix sketch:**
  ```ts
  // source-cache.ts:373
  const ctx = getRequestContext();
  const payload = { ...fact, ...(ctx?.requestId ? { request_id: ctx.requestId } : {}) };
  ```
  ```py
  # doc_ingester/importer.py — caller passes request_id; or read from log_context
  from services.mcp_tools.common.log_context import get_log_context
  rid = get_log_context().get("request_id")
  Jsonb({"sha256": sha, ..., **({"request_id": rid} if rid else {})})
  ```
  The doc_ingester is a CLI, not an HTTP request, so the field would be the operator's invocation id; for hook + builtin emits, the `getRequestContext` ALS lookup gets the inflight HTTP id automatically.

### F-5 [HIGH] `record_error_event(...)` exists, has zero callers; `error_events` is never written

* **Files:**
  - `db/init/19_observability.sql:138-199` — function definition, RLS, indexes, NOTIFY trigger
  - Search across `services/`: `grep -rn "SELECT record_error_event\|record_error_event(" services/` returns 0 hits in production code paths.
  - `services/agent-claw/src/errors/codes.ts:3` — comment "the `error_events` DB sink"
  - `services/agent-claw/src/errors/envelope.ts:17` — comment "the `error_events` DB sink) goes through `toEnvelope(err)` so the wire"
* **Evidence:** the function is defined and granted — `EXECUTE ON FUNCTION record_error_event(...) TO chemclaw_app` and `chemclaw_service`. The NOTIFY trigger fires on every insert (`db/init/19_observability.sql:107+`). No code anywhere calls it.
* **Impact:** the durable error audit channel CLAUDE.md describes ("Database-side audit lives in `error_events`") doesn't actually exist at runtime. Any operator running `SELECT * FROM error_events` finds an empty table. The Grafana security dashboard's `error_code =~ "MCP_AUTH_FAILED|MCP_SCOPE_DENIED|DB_RLS_DENIED|..."` query relies on Loki, not `error_events` — so the SQL path is just dead.
* **Fix sketch:** wire `record_error_event` into:
  - The TS error envelope path (`bootstrap/auth.ts:64,90` already builds an envelope; add a `await pool.query("SELECT record_error_event($1,$2,$3,$4)", [...])` after the envelope construction).
  - The Python `error_envelope.py` builder + an outer middleware in `common/app.py` exception handlers.
  - Hook lifecycle's `post_tool_failure` dispatch (currently no handlers).

### F-6 [MEDIUM] Pino `err.message` / `err.stack` not redacted; Python `RedactionFilter` skips `exc_info`/`exc_text`

(carryover from W1.4 P2 — repeated here for completeness)

* **Files:**
  - `services/agent-claw/src/observability/logger.ts:64-69` — comment is explicit
  - `services/mcp_tools/common/redaction_filter.py:62-64` — `_PASSTHROUGH_FIELDS` includes `exc_info`, `exc_text`
* **Evidence:** Postgres errors carry `Failing row contains (...)` with column values, MCP `UpstreamError.message` carries `${service} returned ${status}: ${detail}` (the detail is path-redacted but `*.message` is not), Python exception text from `psycopg.errors.*` is structurally similar.
* **Fix sketch (TS):** add a Pino formatter / serializer that runs the LiteLLM-style regex over `record.msg` and `record.err?.message` / `record.err?.stack`. Mirror `services/litellm_redactor/redaction.py:redact()` in TS. ~150 LOC and keeps the path-redact list as the fast-path.
* **Fix sketch (Python):** override the formatter so `formatException` output is redacted post-render. ~20 LOC patch on `common/logging.py`.

### F-7 [MEDIUM] Audit-log gap on four legacy admin routes

(see "Audit-Log Coverage Matrix" above)

* **Files:**
  - `services/agent-claw/src/routes/forged-tools.ts:161,208` — POST mutators, no `appendAudit`
  - `services/agent-claw/src/routes/skills.ts:55,79` — POST `/api/skills/enable`, `/api/skills/disable`
  - `services/agent-claw/src/routes/eval.ts:99` — POST `/api/eval`
  - `services/agent-claw/src/routes/optimizer.ts` — entire file emits no audit calls
* **Fix sketch:** at every state-mutating branch, follow the canonical pattern:
  ```ts
  await appendAudit(pool, {
    user: callerId,
    action: "<resource>.<verb>",
    target_id: <id>,
    before_value: <before>,
    after_value: <after>,
  });
  ```
  Pair with W1.5 High: collapse the four duplicate `requireAdmin` impls onto `guardAdmin` so the policies fire uniformly.

### F-8 [LOW] CLAUDE.md / logger.ts doc/code mismatch on Pino redaction list

W1.5 already calls this out. CLAUDE.md (line 277): "redacts `authorization` / `cookie` / `err.message` / `err.stack` / `detail` automatically." Code (logger.ts:64-69) deliberately doesn't redact `err.message` / `err.stack`. **The code is correct; the doc is wrong** — operators triaging an incident need the message text. Fix CLAUDE.md, not the code. (Fixing the code requires the content-aware redactor in F-6 first.)

### F-9 [LOW] `mcp_doc_fetcher`, `mcp_drfp`, `mcp_kg`, `mcp_rdkit` have no `ready_check` (missing readyz quality)

The factory's default `ready_check=None` returns `{status: "ok", service: name}` unconditionally — equivalent to `/healthz`. K8s has no signal that these services are unable to actually serve. `mcp_kg`'s factory call passes no ready_check, but the file does define an unused `_readyz_check()` async helper at line 122 that pings Neo4j. **It's just not wired in.**

* **Fix sketch:** wire `_readyz_check` for `mcp_kg`. Add `ready_check=` for `mcp_doc_fetcher` (probe the validator state), `mcp_drfp` (try the rdkit / drfp imports), `mcp_rdkit` (try `Chem.MolFromSmiles("CC")`).

### F-10 [LOW] Two embedded `print()` in generated Python sandbox programs are correctly inside string templates

* `services/agent-claw/src/tools/builtins/run_program.ts:231` — `print(_json.dumps({"__chemclaw_output__": _result}), file=_sys.stdout)` — embedded inside the wrapper template the sandbox runs. NOT a host-side `print`. Whitelisted.
* `services/optimizer/forged_tool_validator/validator.py:138` — `print(_json.dumps({{"__chemclaw_output__": _output}}))` — same pattern, doubled `{{` because the outer template is an f-string. Whitelisted.

### F-11 [LOW] Vendored `mcp_synthegy_mech/molecule_set.py` carries 4 upstream `print()` calls

* `services/mcp_tools/mcp_synthegy_mech/vendored/molecule_set.py` lines 135, 147, 564, 628 — vendored from `github.com/schwallergroup/steer` (MIT). Carry-upstream; not a contract violation since the vendored README says do-not-modify. Still worth noting that any error message / debug emit from the search bypasses the JSON formatter on the way out.

---

## Cross-Reference: Prior Audit (Wave 1 + 2026-04-29)

| Wave 1 finding | This audit's status |
| --- | --- |
| W1.5 — agent-claw zero `console.*` | Confirmed. 0 hits in `src/`. |
| W1.5 — `errors/envelope.ts` consumed by 1 site only | Confirmed. Only `bootstrap/auth.ts` calls `envelopeFor`/`toEnvelope`. |
| W1.5 — Pino `err.message`/`err.stack` not in redact list | Confirmed; W1.4 P2 risk persists. |
| W1.5 — `MIN_EXPECTED_HOOKS` magic constant in start.ts | Out of scope here; W1.5 covers it. |
| W1.6 — many MCP `/readyz` weak | Confirmed and quantified above (1 GOOD, 10 MEDIUM, 8 WEAK, 3 MISSING). |
| W1.6 — `mcp_kg._readyz_check` defined but not wired | Re-confirmed (F-9). |
| W1.7 — `kg_hypotheses` and `kg_source_cache` violate centralised-logging contract | Confirmed; expanded the list to 4 more optimizer services (F-2). |
| W1.7 — `request_id` correlation in BaseProjector is dead | Confirmed; no writer puts it in payload (F-4). |
| W1.7 — `kg_hypotheses` ack key uses hyphen `"kg-hypotheses"` | Out of scope (W1.7). |
| W1.4 P1 — `LOG_USER_SALT` Python loader accepts `PYTEST_CURRENT_TEST` | Confirmed at `user_hash.py:42-46`. The TS side (`user-hash.ts:45-46`) does NOT have this carve-out — only `CHEMCLAW_DEV_MODE=true`. The asymmetry is the gap. |
| W1.4 P2 — `dynamic_patterns.is_pattern_safe` only forbids 7 unbounded-quantifier shapes | Out of scope (security). |
| 2026-04-29 #1 (logger doc/code) | Persists (F-8). |
| 2026-04-29 #2 (no Python OTel) | Persists; `mcp_tools/common/error_envelope.py` reads `trace_id` from a never-existing active span. |

---

## Counts

* **Console / print offenders (production code):** 0 in TS, 0 in Python (all 7 production-tree print()s are in `scripts/` or `seed/` directories that legitimately CLI-print).
* **Embedded print() in sandbox templates:** 2 (whitelisted, not host code).
* **Vendored print():** 4 in `mcp_synthegy_mech/vendored/molecule_set.py` (carry-upstream).
* **Services missing `configure_logging`:** 7 (`kg_hypotheses`, `kg_source_cache`, `session_purger`, `session_reanimator`, `gepa_runner.runner`, `skill_promoter.runner`, `forged_tool_validator.runner`); plus `eln_json_importer.legacy.cli` (legacy path, broken anyway).
* **TS modules using `getLogger`:** 18; `app.log.*` adopters: 2 (correctly inside Fastify-bound bootstrap).
* **Format-string injection in log calls:** 0 in TS, 0 in Python.
* **Pino redact list size:** 14 paths; recommended additions: 3-4 (`*.message`, `*.stack`, `*.smiles` (broaden), `*.compound_code`).
* **`/readyz` distribution:** GOOD 1, MEDIUM 10, WEAK 8, MISSING 3 (out of 22 MCPs).
* **Admin mutating routes that DO call `appendAudit`:** 5 (`/api/admin/{config,feature-flags,permission-policies,redaction-patterns,users}`).
* **Admin mutating routes that DO NOT call `appendAudit`:** 4 routes / 6 endpoints (`forged-tools` POST/disable, `skills` enable/disable, `eval`, `optimizer`).
* **Tool builtins that DO call `appendAudit`:** 7 (workflow_*, promote_workflow_to_tool, enqueue_batch).
* **OTel root-span call sites:** 1 (`chat.ts:258`); routes that should have one but don't: 4+sub-agent.
* **`record_error_event` callers:** 0.
* **`request_id` writers (into `ingestion_events.payload`):** 0.
