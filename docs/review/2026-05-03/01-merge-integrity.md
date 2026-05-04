# Merge Integrity Audit — 2026-05-03

Read-only audit of `chemclaw` `main` after the recent landings of Z0–Z8, applicability-domain, synthegy, condition-design, workflow-engine, QM Phases 1-9, logging, config concept, and optimizer branches. Focus: merge debris, parallel-branch dupes, broken integrations.

Severity legend:
- **P0** — correctness/security broken in a runnable code path
- **P1** — stability risk / regression that surfaces under realistic conditions
- **P2** — maintainability rot / merge debris
- **P3** — nice-to-have cleanup

---

## Executive Summary

| Severity | Finding | File:line | Fix sketch |
|---|---|---|---|
| **P0** | Two new MCP services missing from `SERVICE_SCOPES` → JWT mint throws `McpAuthError` for every call when `MCP_AUTH_SIGNING_KEY` is set | `services/agent-claw/src/security/mcp-token-cache.ts:26-47`, `services/mcp_tools/common/scopes.py:20-41` | Add `"mcp-applicability-domain": "mcp_applicability_domain:invoke"` and `"mcp-green-chemistry": "mcp_green_chemistry:invoke"` to BOTH maps; add a pact test that iterates the agent's tool builtins for `"mcp-*"` literals and asserts each one resolves in `SERVICE_SCOPES` |
| **P0** | Duplicate Docker host port 8015 — `mcp-yield-baseline` and `mcp-genchem` both bind it under the same `chemistry` profile | `docker-compose.yml:1098`, `docker-compose.yml:1226` | Move `mcp-genchem` to a free port (e.g. 8022, also update `MCP_GENCHEM_URL` plumbings in workflow-engine/queue-worker/genchem Dockerfile EXPOSE/CMD) |
| **P0** | `services/workflow_engine/main.py` mixes asyncpg-style `$1`/`$2` placeholders into psycopg3 cursors → every UPDATE in `_advance_one` and `_finish` raises `psycopg.errors.SyntaxError` at runtime | `services/workflow_engine/main.py:169-179`, `services/workflow_engine/main.py:301-310` | Replace `$N` with `%s` (psycopg3 paramstyle) — five placeholders total |
| **P1** | New chemistry-phase tables `workflows`, `workflow_runs`, `workflow_events`, `workflow_state`, `workflow_modifications`, `gen_runs`, `gen_proposals`, `task_batches`, `chemspace_screens`, `chemspace_results` carry `created_by`/`requested_by` user identity columns but have **no** RLS — every authenticated `chemclaw_app` user can read every other user's runs and seed data | `db/init/26_genchem.sql:8-21`, `db/init/27_job_queue.sql:46-57`, `db/init/28_screens.sql:10-22`, `db/init/29_workflows.sql:17-110` | Add `ENABLE ROW LEVEL SECURITY; FORCE ROW LEVEL SECURITY;` + `created_by = current_setting('app.current_user_entra_id', true)` policies on each user-scoped table; chemistry catalog tables (`bioisostere_rules`, `mmp_pairs`) are tenant-agnostic and OK |
| **P1** | Helm chart `chemistry-deployments.yaml` is missing 11 services merged in the last two weeks (`mcp-yield-baseline`, `mcp-plate-designer`, `mcp-ord-io`, `mcp-reaction-optimizer`, `mcp-applicability-domain`, `mcp-green-chemistry`, `mcp-genchem`, `mcp-crest`, `mcp-synthegy-mech`, `workflow-engine`, `queue-worker`) — Helm-based deploys silently miss them | `infra/helm/templates/chemistry-deployments.yaml:1-11` | Add deployment dicts (image / port / values keys) for each new service, then add matching `chemistry.mcp<Name>` entries in `infra/helm/values.yaml` and `prod-values.yaml` |
| **P1** | Permission policies are silently ignored on `/api/sessions/*/plan/run`, `/api/sessions/*/resume`, `/api/plan/preview` (and approve), `/api/deep_research`. Only `/api/chat` passes `permissions: { permissionMode: "enforce" }` to `runHarness`/`runChainedHarness`, so a `permission_policies` row of `decision='deny'` won't fire on any of those routes | `services/agent-claw/src/routes/sessions-handlers.ts:169,278`, `services/agent-claw/src/routes/plan.ts:104`, `services/agent-claw/src/routes/deep-research.ts` | Pass `permissions: { permissionMode: "enforce" }` at every harness call site (already in `BACKLOG.md` line 6) |
| **P1** | TypeScript and Python token caches diverge on the "unknown service" path: TS throws `McpAuthError`, Python logs a warning and mints an unscoped token. So workflow_engine + queue-worker silently work-with-warn for the same SERVICE_SCOPES gap that hard-fails the agent | `services/agent-claw/src/security/mcp-token-cache.ts:90-97` vs `services/mcp_tools/common/mcp_token_cache.py:73-80` | Make Python raise `McpAuthError` to match TS — consistent fail-loud removes the silent-403 surface |
| **P2** | Six SQL init filename-prefix collisions (`02_*`, `18_*`, `19_*` ×4, `20_*`, `21_*`) — Postgres lex-order is fragile because `19_observability.sql` will sort by full filename and depends on no other 19_ file but readers can't tell at a glance. The `current_user_is_admin()` dependency from `18_admin_roles_and_audit.sql` to `19_config_settings.sql` works only because the admin file alphabetically precedes the finish-reason widen file | `db/init/02_*.sql`, `db/init/18_*.sql`, `db/init/19_*.sql`, `db/init/20_*.sql`, `db/init/21_*.sql` | Renumber so each integer prefix is unique — propose `18a_*`, `18b_*` style; the BACKLOG already calls for moving to a real migration tool (line 44), but in the interim a renumbering PR removes the lex-order trap |
| **P2** | `chemclaw.bootstrap_admins` setting referenced by `db/init/18_admin_roles_and_audit.sql:156` but no wrapper script ever sets it. Comment lies: "the setting is propagated by db/init's wrapper script when present" | `db/init/18_admin_roles_and_audit.sql:152-167` | Either remove the DO-block (admins added via API) or add a `make` target that does `ALTER DATABASE chemclaw SET chemclaw.bootstrap_admins = '${AGENT_ADMIN_USERS}'` before re-running 18 |
| **P2** | Files `23_qm_results.sql` through `29_workflows.sql` self-INSERT into `schema_version` while the Makefile loop ALSO INSERTs — both are `ON CONFLICT DO NOTHING` so harmless, but inconsistent with files 17/18/19/20/21/22 (no self-INSERT) | `db/init/23_qm_results.sql:end`, `db/init/24-29_*.sql:end` | Pick one: either add the self-INSERT to all 17-22, or remove from 23-29 |
| **P2** | `audit_log` partition maintenance not implemented. Comment at `db/init/19_observability.sql:236-238` mentions "monthly cron job (see services/optimizer/audit_partition_maintainer if added later)" — no such service exists, so after 3 months audit INSERTs raise "no partition for row" (caught by EXCEPTION handler that forwards to `error_events`, which is functional but loses audit rows silently) | `db/init/19_observability.sql:236-262` | Add the partition-maintainer to `services/optimizer/` (15 LOC: `CREATE TABLE IF NOT EXISTS audit_log_y$Y$M PARTITION OF audit_log FOR VALUES ...` cron-style) |
| **P2** | Test count assertion in `CLAUDE.md:262` says "772 vitest tests pass / 102 files" but the agent-claw tree now ships 146 test files. `MIN_EXPECTED_HOOKS = 11` is correctly aligned with hooks count | `CLAUDE.md:262` | Refresh test counts in CLAUDE.md and the autonomy upgrade memory file |
| **P3** | Many env vars referenced by code but missing from `.env.example`: `AIZYNTH_CONFIG`, `ASKCOS_MODEL_DIR`, `CHEMBENCH_DATASET_PATH`, `CHEMCLAW_SERVICE_DSN`, `CHEMPROP_MODEL_DIR`, `DB_SLOW_TXN_MS`, `DOYLE_DATASET_PATH`, `GEPA_MODEL`, `GEPA_PORT`, `LITELLM_API_KEY`, `LITELLM_BASE_URL`, `LITELLM_PLANNER_MODEL`, `LITELLM_REDACTION_LOG_SAMPLE`, `LOG_ACCESS_PROBES`, `LOG_FORMAT`, `LOG_LEVEL` (top-level — only sub-prefixes are documented), `MCP_CREST_URL`, `MCP_DOC_FETCHER_FILE_ROOTS`, `MCP_GENCHEM_URL`, `MCP_TABICL_PCA_PATH`, `MCP_XTB_BASE_URL`, `MCP_XTB_STEP_TIMEOUT_SECONDS`, `MCP_XTB_WORKFLOW_TIMEOUT_SECONDS`, `MCP_YIELD_BASELINE_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `PAPERCLIP_*` (six), `POSTGRES_DSN`, `REDACTOR_PG_DSN`, `SANDBOX_MAX_CPU_S`, `SANDBOX_MAX_NET_EGRESS`, `SKILL_PROMOTER_PORT`, `WORLD_SEED` | `.env.example` | Add each with a sensible dev default + comment; document which the production deploy must override |
| **P3** | No Docker healthcheck on `workflow-engine` and `queue-worker` — both are LISTEN/NOTIFY consumers with no HTTP endpoint, so this is acceptable but deviates from the every-MCP-has-healthcheck convention | `docker-compose.yml:327-381` | Add a TCP-port-based health probe (the queue-worker exposes none; consider a sidecar `/healthz` over an internal port) OR document the absence in the compose comment |
| **P3** | Stale port-mapping comment: `db/init/29_workflows.sql:53` says "intentionally not FK'd to agent_sessions" but no test verifies the comment matches behaviour | `db/init/29_workflows.sql:39-54` | Add a one-line test: insert a workflow_run with a session_id that doesn't exist in agent_sessions, assert no FK error |

---

## Full Appendix

### F-01 (P0) — `mcp-applicability-domain` and `mcp-green-chemistry` missing from SERVICE_SCOPES

**Evidence.**

`services/agent-claw/src/security/mcp-token-cache.ts:26-47` (TS map, 20 entries):
```ts
export const SERVICE_SCOPES: Record<string, string> = {
  "mcp-rdkit": "mcp_rdkit:invoke",
  "mcp-drfp": "mcp_drfp:invoke",
  // ... 18 more
};
```

`services/mcp_tools/common/scopes.py:20-41` (Python mirror, also 20 entries) — both lack `mcp-applicability-domain` and `mcp-green-chemistry`.

But the agent's tool tree contains:
```
$ grep -rEn '"mcp-[a-z-]+"' services/agent-claw/src/tools/ | grep -oE '"mcp-[a-z-]+"' | sort -u
"mcp-aizynth"
"mcp-applicability-domain"  ← in code, not in SERVICE_SCOPES
"mcp-askcos"
...
"mcp-green-chemistry"        ← in code, not in SERVICE_SCOPES
"mcp-tabicl"
"mcp-xtb"
"mcp-yield-baseline"
```

`assess_applicability_domain.ts:234,253,278,287` and `score_green_chemistry.ts:60` pass `"mcp-applicability-domain"` / `"mcp-green-chemistry"` to `postJson(...)`, which calls `getMcpToken()` which goes through:

```ts
// mcp-token-cache.ts:90-97
const scope = SERVICE_SCOPES[opts.service];
if (!scope) {
  throw new McpAuthError(
    `unknown MCP service ${JSON.stringify(opts.service)}; ` +
      "add it to SERVICE_SCOPES in mcp-token-cache.ts and the Python mirror " +
      "in services/mcp_tools/common/scopes.py",
  );
}
```

When `MCP_AUTH_SIGNING_KEY` is set (production posture per CLAUDE.md), every call to these two tools throws at the mint step BEFORE the HTTP request leaves the agent. Tests don't catch this because `tests/unit/mcp-token-cache.test.ts:121-125` only iterates `Object.keys(SERVICE_SCOPES)`; it does not assert that every `"mcp-*"` literal in the tool builtins resolves.

CLAUDE.md says "A pact test asserts equality; keep both maps in sync by hand" — but the only `SERVICE_SCOPES` test is the per-entry shape check above. There's no cross-language pact (despite the comment claiming `tests/integration/test_scope_pact.py`):
```
$ find tests services -name "*scope_pact*"
(no matches)
```

The `services/mcp_tools/common/app.py:116-128` startup guard catches the OPPOSITE direction (catalog omission + no explicit `required_scope`) at server boot. Both green-chem and applicability-domain pass an explicit `required_scope=` so the server starts cleanly:
```py
# mcp_green_chemistry/main.py:54-61
app = create_app(
    name="mcp-green-chemistry",
    required_scope="mcp_green_chemistry:invoke",  ← explicit, server starts
    ...
)
```
The server cheerfully accepts `mcp_green_chemistry:invoke`-scoped tokens — but the agent never produces one, because mint fails first.

**Why it's a problem.** Two new agent-callable tools are silently broken in production. Symptom is `McpAuthError` at the agent's tool-execution boundary, surfacing as "unknown MCP service mcp-applicability-domain" — easy to misdiagnose as a typo in the tool name.

**Fix.** One-liner each + add the missing pact test:
```ts
// mcp-token-cache.ts
"mcp-applicability-domain": "mcp_applicability_domain:invoke",
"mcp-green-chemistry": "mcp_green_chemistry:invoke",
```
```py
# scopes.py
"mcp-applicability-domain": "mcp_applicability_domain:invoke",
"mcp-green-chemistry": "mcp_green_chemistry:invoke",
```
And the missing pact test (vitest):
```ts
// tests/unit/scope-pact.test.ts (NEW)
import { glob } from "glob";
import { readFileSync } from "fs";
import { SERVICE_SCOPES } from "../../src/security/mcp-token-cache.js";

it("every 'mcp-*' literal in tool builtins is in SERVICE_SCOPES", () => {
  const refs = new Set<string>();
  for (const f of glob.sync("src/tools/builtins/**/*.ts")) {
    const m = readFileSync(f, "utf-8").matchAll(/"mcp-[a-z-]+"/g);
    for (const x of m) refs.add(x[0].slice(1, -1));
  }
  for (const r of refs) expect(SERVICE_SCOPES[r]).toBeDefined();
});
```

**Test.** Set `MCP_AUTH_SIGNING_KEY` in `.env`, start the agent, call `score_green_chemistry`. Today: `McpAuthError`. After fix: a real HTTP 200/4xx from the MCP service.

**Blast radius.** Z1 features (applicability-domain calibration, green chemistry scoring, condition-design skill v2) are non-functional in any production-shaped deployment.

---

### F-02 (P0) — Duplicate Docker host port 8015 (genchem vs yield-baseline)

**Evidence.**

`docker-compose.yml`:
```yaml
# line 1090-1098
mcp-yield-baseline:
  ...
  profiles: ["chemistry"]
  ports:
    - "8015:8015"

# line 1218-1226
mcp-genchem:
  ...
  profiles: ["chemistry"]
  ports:
    - "8015:8015"
```

Both Dockerfiles also EXPOSE / CMD on 8015:
- `services/mcp_tools/mcp_genchem/Dockerfile:14`: `ENV MCP_TOOL_PORT=8015`
- `services/mcp_tools/mcp_yield_baseline/Dockerfile:24`: `CMD ["...", "--port", "8015"]`

Detected via:
```
$ grep -E '^\s+- "[0-9]+:[0-9]+"' docker-compose.yml | sort | uniq -c | sort -rn | head
   2       - "8015:8015"
   1       - "8021:8021"
   ...
```

Other env-var plumbing also expects `mcp-genchem:8015`:
```yaml
# docker-compose.yml:346
MCP_GENCHEM_URL: http://mcp-genchem:8015
# (workflow-engine and queue-worker both hardcode it)
```

**Why it's a problem.** `docker compose --profile chemistry up -d` brings up both. The second to start (Compose serializes by file order) fails with `Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:8015 failed: port is already allocated`. Z3 (yield baseline) and Phase-5 (genchem) are mutually exclusive in this configuration. The container-internal port is also 8015 in both cases, so even if you change just the host mapping, you have to update the container CMD as well.

**Fix.** Pick one to relocate. Recommend `mcp-genchem` → 8022 (next free port), since:
- `docker-compose.yml:1226` becomes `- "8022:8022"`
- `services/mcp_tools/mcp_genchem/Dockerfile:14,17,24` (EXPOSE 8015, CMD --port 8015) → 8022
- Healthcheck URL `http://127.0.0.1:8015/readyz` → `8022/readyz`
- Three call sites that hardcode `MCP_GENCHEM_URL`: `docker-compose.yml:346,378` (workflow-engine, queue-worker), and `docker-compose.yml:1101` (yield-baseline does NOT call genchem; only matters for the engine + worker).
- Consider also updating `mcp_genchem` test fixtures and any agent-claw env defaults.

**Test.**
```bash
docker compose --profile chemistry up -d
docker compose ps | grep -E "(yield-baseline|genchem)"  # both Up, no Exit code
```

**Blast radius.** Both services unable to coexist; Phase-5 + Phase-Z3 functional regression in any chemistry-profile deployment.

---

### F-03 (P0) — `workflow_engine` SQL placeholders use asyncpg `$N` syntax inside psycopg3

**Evidence.** `services/workflow_engine/main.py`:

```py
# requirements.txt:1 — psycopg[binary]>=3.2

# main.py:168-179
async with work_conn.cursor() as cur:
    await cur.execute(
        """
        UPDATE workflow_state
           SET current_step = $1::text,
               scope = $2::jsonb,
               cursor = $3::jsonb,
               updated_at = NOW()
         WHERE run_id = $4::uuid
        """,
        (step_id, json.dumps(scope), json.dumps(cursor), run_id),
    )
```

```py
# main.py:300-310
await cur.execute(
    """
    UPDATE workflow_runs
       SET status = $1,
           finished_at = NOW(),
           output = $2::jsonb
     WHERE id = $3::uuid
    """,
    (status, json.dumps(outputs), run_id),
)
```

psycopg3 paramstyle is `pyformat` (`%s` / `%(name)s`); `$1`-style placeholders are an asyncpg idiom. Other psycopg cursors in the same file correctly use `%s` (e.g. line 235-238 in `_exec_wait`, line 281-289 in `_append_event`). Both `$1` blocks are inside late-merged code from b4a37b3 / a6bd063.

`services/workflow_engine/tests/test_engine.py` doesn't exercise either of these UPDATEs — it only tests `_resolve_jmespath` and `_tool_url`, both pure-function helpers.

**Why it's a problem.** Any successful `tool_call` step crashes `_advance_one` at the post-step state UPDATE (line 169) because psycopg parses `$1` as literal text and complains "got 4 parameters, expected 0". The workflow finishes-via-failure path (`_finish` at line 301) hits the same defect, so even a degraded workflow run cannot mark itself failed.

**Fix.**
```py
# Replace both UPDATEs to use %s — same shape as _exec_wait / _append_event
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
```

**Test.** Integration test that creates a workflow_run, drives it to step_succeeded, asserts the row in workflow_state shows `current_step` set. Today: `psycopg.errors.SyntaxError`. After fix: row visible.

**Blast radius.** Phase 8 (workflow engine) is non-functional. Any `workflow_run` builtin call on a real DB fails after the first step.

---

### F-04 (P1) — New chemistry/queue/workflow tables lack RLS

**Evidence.**

```sql
-- db/init/29_workflows.sql:35-49
CREATE TABLE IF NOT EXISTS workflow_runs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  ...
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- no ENABLE ROW LEVEL SECURITY anywhere in the file
```

```
$ grep -E "ENABLE ROW LEVEL|FORCE ROW" db/init/{23,24,25,26,27,28,29}_*.sql
db/init/19_observability.sql:225  ← (unrelated, separate file)
db/init/19_reaction_optimization.sql:56  ← model_cards, catalog table
# nothing in 23..29
```

Tables holding user-identity data without RLS:
| File | Table | User column |
|---|---|---|
| `26_genchem.sql` | `gen_runs` | `requested_by` |
| `27_job_queue.sql` | `task_batches` | `created_by` |
| `28_screens.sql` | `chemspace_screens` | `created_by` |
| `29_workflows.sql` | `workflows` | `created_by` |
| `29_workflows.sql` | `workflow_runs` | `created_by` |
| `29_workflows.sql` | `workflow_modifications` | `modified_by` (similar shape) |

`task_queue.payload` (line 11-29 of `27_job_queue.sql`) is the JSONB carrying every queued chemistry-search request body — also unprotected, also reachable from `chemclaw_app`.

CLAUDE.md "Row-Level Security — the rule" explicitly says **every project-scoped table must have FORCE RLS**. These tables miss the rule.

The grants pattern in `29_workflows.sql:117-130` explicitly grants `chemclaw_app` `SELECT, INSERT, UPDATE` — so `chemclaw_app` (the role used by the agent's user-facing pool) reads across users freely:
```sql
IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
  GRANT SELECT, INSERT, UPDATE
    ON workflows, workflow_runs, workflow_events,
       workflow_state, workflow_modifications
    TO chemclaw_app;
END IF;
```

**Why it's a problem.** The agent runs every user-facing query through `withUserContext` which sets `app.current_user_entra_id`, but with no RLS policy on these tables, **the setting is ignored** for these queries. A user A who knows the workflow_id of user B's run can read it via any agent path that selects from `workflow_runs` — e.g., `workflow_inspect`. Multi-tenant data leakage.

**Fix.** Per table:
```sql
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_runs_owner ON workflow_runs;
CREATE POLICY workflow_runs_owner ON workflow_runs
  FOR ALL
  USING (created_by = current_setting('app.current_user_entra_id', true)
         OR current_user_is_admin())
  WITH CHECK (created_by = current_setting('app.current_user_entra_id', true)
              OR current_user_is_admin());
```
Repeat for `workflows` (drop the user filter for the catalog rows; only enforce on user-created workflow definitions), `workflow_events`, `workflow_state`, `workflow_modifications`, `gen_runs`, `task_batches`, `chemspace_screens`, `chemspace_results` (filter by parent screen's `created_by`).

**Test.** Insert two `workflow_runs` as distinct users; inside `withUserContext(userA, ...)` SELECT and assert only userA's row returns. Mirror for each other table.

**Blast radius.** All Phase 5 (focused-generation), Phase 6 (job queue), Phase 7 (chemspace screens), Phase 8 (workflow engine) features have multi-tenant data leakage as soon as more than one user shares the deployment.

---

### F-05 (P1) — Helm chart missing 11 services

**Evidence.** `infra/helm/templates/chemistry-deployments.yaml` lists exactly 11 services:
```yaml
(dict "name" "mcp-rdkit"     ...)
(dict "name" "mcp-drfp"      ...)
(dict "name" "mcp-kg"        ...)
(dict "name" "mcp-embedder"  ...)
(dict "name" "mcp-tabicl"    ...)
(dict "name" "mcp-doc-fetcher" ...)
(dict "name" "mcp-askcos"    ...)
(dict "name" "mcp-aizynth"   ...)
(dict "name" "mcp-chemprop"  ...)
(dict "name" "mcp-xtb"       ...)
(dict "name" "mcp-sirius"    ...)
```

```
$ grep -rE "mcp-yield|mcp-plate|mcp-ord-io|mcp-reaction-opt|mcp-applic|mcp-green|mcp-genchem|mcp-crest|mcp-synthegy|workflow-engine|queue-worker" infra/helm/
(no matches)
```

These services exist in `docker-compose.yml` (lines 1037-1384) but never in Helm. `mcp-eln-local` and `mcp-logs-sciy` are also absent (they live under `sources` profile in compose, but the Helm template `sources-deployments.yaml` was not updated).

**Why it's a problem.** Production deploys go through Helm per `infra/helm/Chart.yaml`. Every Z-phase chemistry service is missing → a Helm-based prod deploy ships v1.0.0-claw without Z0-Z8 features even though tests pass and CI is green. The compose `make up` developer flow works; the prod flow doesn't.

**Fix.** Mirror each compose service into `chemistry-deployments.yaml` (or the appropriate sub-template). For each service:
- one entry in the dict iteration
- a corresponding `chemistry.mcp<Name>: { image, port, replicas, profileEnabled }` block in `values.yaml` and `prod-values.yaml`

**Test.** `helm template infra/helm | grep -E 'kind: Deployment' | wc -l` — should equal docker-compose's chemistry-profile services.

**Blast radius.** Production rollouts of all Z-phase + Phase 5/6/7/8 features.

---

### F-06 (P1) — `permissionMode: "enforce"` only set on `/api/chat`

**Evidence.**
```
$ grep -n "permissionMode\|permissions:" services/agent-claw/src/routes/{chat,plan,deep-research,sessions-handlers}.ts
services/agent-claw/src/routes/chat.ts:405:      permissions: { permissionMode: "enforce" },
```
No other route (plan, deep-research, sessions-handlers — including the chained-execution call at sessions-handlers.ts:169 and resume at 278) passes the `permissions` option to `runHarness` / `runChainedHarness`.

The harness applies the permission resolver only when called with `{ permissions: { permissionMode: "enforce" } }` (CLAUDE.md "Permission policies" / `core/step.ts:160`). Without it, every `permission_policies` row of `decision='deny'` or `'ask'` is silently inert on those routes.

This is also tracked in `BACKLOG.md:6`:
> [agent-claw/permissions] wire remaining 5 `runHarness` / `runChainedHarness` call sites with `{ permissionMode: 'enforce' }` — `chat.ts` is done; still missing: `routes/plan.ts`, `routes/deep-research.ts` (×2 sites), `routes/sessions-handlers.ts` (×2 sites)

**Why it's a problem.** A site admin sets `INSERT INTO permission_policies ... decision='deny' tool_pattern='Bash'` expecting it to apply across the agent surface. It applies to `/api/chat` only. Plan-mode, deep-research, and chained execution all bypass it.

**Fix.** Pass the option at each call site:
```ts
// sessions-handlers.ts:169
const result = await runChainedHarness({
  ...rest,
  permissions: { permissionMode: "enforce" },
});
```
Same shape for the 4 other sites.

**Test.** Add a `permission_policies` row with `decision='deny' tool_pattern='canonicalize_smiles'`; POST to `/api/sessions/:id/plan/run` with a turn that calls that tool; assert the harness aborts with `permission_denied`. Today: passes through.

**Blast radius.** Operators believe deny-rules are enforced site-wide; they aren't.

---

### F-07 (P1) — TS / Python token caches diverge on missing-scope behaviour

**Evidence.**

TS (`services/agent-claw/src/security/mcp-token-cache.ts:86-97`):
```ts
const scope = SERVICE_SCOPES[opts.service];
if (!scope) {
  throw new McpAuthError(`unknown MCP service ${...}; ...`);
}
```

Python (`services/mcp_tools/common/mcp_token_cache.py:73-80`):
```py
scope = SERVICE_SCOPES.get(service)
if scope is None:
    log.warning(
        "no SERVICE_SCOPES entry for %s; minting an unscoped token",
        service,
        extra={"event": "mcp_token_no_scope", "service": service},
    )
    scope = ""
```

Same condition, opposite outcomes: TS hard-fails, Python warns and mints an unscoped token. The MCP service-side will reject an unscoped token at the scope check (returns 403), so Python actually still fails — just one HTTP round-trip later, and as a less-actionable error.

**Why it's a problem.** Inconsistency makes the failure mode different across the language boundary for what is supposed to be a mirrored map (the map even comments "A pact test asserts equality"). The Python side ALSO loses the fail-fast signal — operator gets "403 forbidden" from logs/sciy, has to dig back to the workflow_engine to discover the SERVICE_SCOPES omission.

**Fix.** Make Python raise `McpAuthError` to match TS:
```py
scope = SERVICE_SCOPES.get(service)
if scope is None:
    raise McpAuthError(
        f"unknown MCP service {service!r}; "
        "add it to SERVICE_SCOPES in services/mcp_tools/common/scopes.py "
        "and the TypeScript mirror in services/agent-claw/src/security/mcp-token-cache.ts"
    )
```

**Test.** Workflow-engine integration test that calls a tool with a service name not in SERVICE_SCOPES; assert raise.

**Blast radius.** Cross-language consistency; reducing time-to-diagnose mint mismatches.

---

### F-08 (P2) — Six SQL filename-prefix collisions

**Evidence.**

```
$ ls db/init/ | sed -E 's/_.*//' | sort | uniq -c | awk '$1>1'
   2 02
   2 18
   4 19
   2 20
   2 21
```

Dependency map (lex order that Postgres's docker-entrypoint and Makefile both use):

| File | Depends on | Provided by |
|---|---|---|
| `02_harness.sql` | nothing in 02 | independent |
| `02_research_reports.sql` | nothing in 02 | independent |
| `18_admin_roles_and_audit.sql` | nothing in 18 | defines `current_user_is_admin()` |
| `18_finish_reason_widen.sql` | `agent_sessions` from 13/16 | independent of 18_admin |
| `19_agent_todos_unique_ordering.sql` | `agent_todos` from 13 | independent |
| `19_config_settings.sql` | `current_user_is_admin()` from 18_admin (RLS policy line 109/114) | depends on 18_admin |
| `19_observability.sql` | `error_events`, `audit_log` self; trigger loop guards on `information_schema.tables` so it tolerates missing targets | independent |
| `19_reaction_optimization.sql` | `set_updated_at()` from 01 | depends on 01 |
| `20_conditions_schema.sql` | `reactions` from 01 | depends on 01 |
| `20_redaction_patterns.sql` | `current_user_is_admin()` from 18_admin (RLS policy line 112) | depends on 18_admin |
| `21_optimization_campaigns.sql` | `model_cards` from 19_reaction_optimization | depends on 19_reaction |
| `21_permission_policies.sql` | `current_user_is_admin()` from 18_admin | depends on 18_admin |

Today the alphabetical lex order resolves the dependencies correctly. But the next time someone files a 19_X file that defines a function depending on 19_observability, they have to know that `19_observability.sql` < `19_X.sql` only by full filename. This is fragile.

The earlier audit (2026-04-29 H1) flagged the Makefile bug where only `01_schema.sql` was re-applied; that's been fixed (Makefile now loops over `db/init/*.sql`). The collision risk is a NEW finding from the merge.

The BACKLOG already calls for moving to a real migration tool (line 44).

**Why it's a problem.** Incoming PRs from parallel sessions will hit the same prefix and the merger has to know the dependency order. There's no static check.

**Fix.** Renumber so each integer is unique:
- `02_harness.sql` → `02a_harness.sql`
- `02_research_reports.sql` → `02b_research_reports.sql`
- … same shape for 18/19/20/21.

(Suggested as the smallest interim step before a real migration tool lands per BACKLOG line 44.)

**Test.** `make db.init && make db.init` (idempotency) on a fresh volume.

**Blast radius.** Future merge conflicts; near-term invisible.

---

### F-09 (P2) — `chemclaw.bootstrap_admins` setting plumbing missing

**Evidence.** `db/init/18_admin_roles_and_audit.sql:152-167`:
```sql
DO $$
DECLARE
  v_raw TEXT := coalesce(current_setting('chemclaw.bootstrap_admins', true), '');
  ...
  IF v_id <> '' THEN
    INSERT INTO admin_roles (user_entra_id, role, scope_id, granted_by)
      VALUES (lower(v_id), 'global_admin', '', 'bootstrap:18_admin_roles_and_audit.sql')
    ON CONFLICT DO NOTHING;
  END IF;
  ...
```

```
$ grep -rn "chemclaw.bootstrap_admins\|bootstrap_admins" db/ scripts/ Makefile
db/init/18_admin_roles_and_audit.sql:156:  v_raw TEXT := coalesce(current_setting('chemclaw.bootstrap_admins', true), '');
```

Comment at line 152 says "the setting is propagated by db/init's wrapper script when present" — but no wrapper exists.

**Why it's a problem.** The DO block is dead code: `current_setting(..., true)` returns NULL → `coalesce → ''` → the FOR loop iterates zero entries. The fallback bootstrap-admin path is `AGENT_ADMIN_USERS` env var read by the agent-claw process, which adds itself at first request. Both work, but the SQL DO block is dead and misleads code readers.

**Fix.** Two options:
1. Wire it: add to `Makefile:db.init` a `psql -c "ALTER DATABASE chemclaw SET chemclaw.bootstrap_admins = '${AGENT_ADMIN_USERS}'"` BEFORE the loop.
2. Remove the DO block; document `AGENT_ADMIN_USERS` as the single bootstrap path.

**Test.** `make db.init`; `psql -c "SELECT * FROM admin_roles WHERE granted_by LIKE 'bootstrap:%'"` — should return rows or document why empty.

**Blast radius.** Operator confusion; no functional break.

---

### F-10 (P2) — Inconsistent self-INSERT-into-`schema_version`

**Evidence.**
```
$ grep -l "INSERT INTO schema_version" db/init/*.sql
db/init/23_qm_results.sql
db/init/24_compound_fingerprints.sql
db/init/25_compound_ontology.sql
db/init/26_genchem.sql
db/init/27_job_queue.sql
db/init/28_screens.sql
db/init/29_workflows.sql
```

Files 23-29 self-INSERT (last few lines of each). The Makefile loop at `Makefile:97-99` ALSO inserts a row per file unconditionally. Both have `ON CONFLICT DO NOTHING`. Files 02-22 and 30-31 have NO self-INSERT and rely on the Makefile loop.

**Why it's a problem.** Inconsistent style; harmless but a silent contract drift between PRs. If a future migration adds the self-INSERT for 30/31 but Postgres's docker-entrypoint runs them (no Makefile loop on first boot), the table stays empty for 02-22 anyway.

**Fix.** Pick one style. Cleanest is to remove the self-INSERTs from 23-29 (the Makefile loop covers them) — keeps each migration single-purpose.

**Blast radius.** None functionally; consistency only.

---

### F-11 (P2) — `audit_log` partition maintainer not implemented

**Evidence.** `db/init/19_observability.sql:236-262` bootstraps 3 monthly partitions, then comments:
```sql
-- Bootstrap partitions: current month + next 2 months. A monthly cron
-- job (see services/optimizer/audit_partition_maintainer if added later)
-- creates the next month's partition before it's needed.
```

```
$ ls services/optimizer/audit_partition_maintainer 2>/dev/null; echo $?
ls: services/optimizer/audit_partition_maintainer: No such file or directory
1
```

When the 3-month bootstrap window expires (~ end of M+2), every audited write hits no-partition. The trigger has an EXCEPTION block that forwards to `error_events` (line 342-359), so the user transaction succeeds — but every audit row from then on is lost silently except for the error_events forward.

**Why it's a problem.** Three months from `make db.init` on a fresh deployment, audit silently degrades. `error_events` would be flooded with `AUDIT_LOG_INSERT_FAILED` rows.

**Fix.** Add `services/optimizer/audit_partition_maintainer/main.py` that runs on a daily cron:
```py
async def maintain():
    async with await psycopg.AsyncConnection.connect(dsn) as conn, conn.cursor() as cur:
        for offset in range(2, 4):  # 2 and 3 months out
            await cur.execute("""
                CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_log
                  FOR VALUES FROM (%L) TO (%L)
            """, ...)
```
Tracked similarly to other optimizer cron jobs (`session_reanimator`, `gepa_runner`).

**Blast radius.** Long-tail audit gaps; inflated error_events.

---

### F-12 (P2) — Test count assertions in CLAUDE.md stale

**Evidence.**
```
CLAUDE.md:259 → "cd services/agent-claw && npm test → 772 passed (102 files)"

$ find services/agent-claw/tests -name "*.test.ts" | wc -l
146
```

A 44-file delta. The actual test count is similarly inflated (the merges added many tests).

**Fix.** Re-run `make test` on a clean tree, update CLAUDE.md and `~/.claude/projects/-...-chemclaw-chemclaw/memory/MEMORY.md`. Low priority; it's a doc drift only.

---

### F-13 (P3) — Env-var sprawl

**Evidence.** Diff between `process.env`/`os.environ` references and `.env.example`:

```
$ comm -23 /tmp/env_referenced.txt /tmp/env_example_keys.txt
AIZYNTH_CONFIG
ASKCOS_MODEL_DIR
CHEMBENCH_DATASET_PATH
CHEMCLAW_SERVICE_DSN
CHEMPROP_MODEL_DIR
DB_SLOW_TXN_MS
DOYLE_DATASET_PATH
GEPA_MODEL
GEPA_PORT
LITELLM_API_KEY
LITELLM_BASE_URL
LITELLM_PLANNER_MODEL
LITELLM_REDACTION_LOG_SAMPLE
LOG_ACCESS_PROBES
LOG_FORMAT
LOG_LEVEL
MCP_AUTH_DEV_MODE       (only commented in .env.example)
MCP_AUTH_REQUIRED       (only commented)
MCP_CREST_URL
MCP_DOC_FETCHER_FILE_ROOTS
MCP_GENCHEM_URL
MCP_TABICL_PCA_PATH
MCP_XTB_BASE_URL
MCP_XTB_STEP_TIMEOUT_SECONDS
MCP_XTB_WORKFLOW_TIMEOUT_SECONDS
MCP_YIELD_BASELINE_URL
OTEL_EXPORTER_OTLP_ENDPOINT
PAPERCLIP_HEARTBEAT_TTL_MS
PAPERCLIP_HOST
PAPERCLIP_PG_DSN
PAPERCLIP_PORT
PAPERCLIP_REFRESH_INTERVAL_MS
PAPERCLIP_SKIP_START
PAPERCLIP_STALE_MS
POSTGRES_DSN
PYTEST_CURRENT_TEST     (false positive — pytest internal)
REDACTOR_PG_DSN
SANDBOX_MAX_CPU_S
SANDBOX_MAX_NET_EGRESS
SKILL_PROMOTER_PORT
WORLD_SEED
```

(`INFO` and `PYTEST_CURRENT_TEST` are false positives.)

**Fix.** Add to `.env.example` with sensible dev defaults; group by service.

---

### F-14 (P3) — workflow-engine + queue-worker no healthcheck

**Evidence.**
```
$ awk '/^  [a-z][a-z-]*:$/{svc=$1} /healthcheck:/{print svc, "HAS"} /security_opt:/{print svc, "SEC"}' docker-compose.yml | sort -u | awk '{c[$1]=c[$1]" "$2} END{for(k in c) print k, c[k]}' | grep -v HAS
chunk-embedder:  SEC
compound-classifier:  SEC
compound-fingerprinter:  SEC
conditions-normalizer:  SEC
contextual-chunker:  SEC
doc-ingester:  SEC
forged-tool-validator:  SEC
kg-experiments:  SEC
kg-hypotheses:  SEC
kg-source-cache:  SEC
promtail:  SEC
qm-kg:  SEC
queue-worker:  SEC
reaction-vectorizer:  SEC
session-purger:  SEC
workflow-engine:  SEC
```

These are all event-loop-only services with no HTTP port; absence of healthcheck is acceptable. Documented here so it's clear it's intentional.

**Fix.** Optional: add a `pgrep python` healthcheck so a crashed worker process restarts via Compose's `restart: unless-stopped` even when its main loop wedges silently. Or add a comment explaining why no healthcheck.

---

## Cross-Reference: Prior Audit (2026-04-29)

### Fixed since 2026-04-29

- **C1** (redactor `RXN_SMILES` CPU-DoS) — both Python (`redaction.py:128` gates on `v.count(">") >= 2`) and TS (`redact-secrets.ts:79-80` gates on `firstArrow !== -1 && value.includes(">", firstArrow + 1)`) now pre-gate.
- **C2** (SSRF IPv4-mapped-IPv6) — fixed at `services/mcp_tools/mcp_doc_fetcher/validators.py:101-111`.
- **C6** (mock_eln seed `\copy ... FROM PROGRAM` SQL) — needs verification, not in this audit's scope.
- **H1** (Makefile only re-applies 01_schema.sql) — fixed; `Makefile:91-101` now loops `for f in db/init/*.sql; do ...; done`.
- **H4** (`forged-tools.ts` not registered) — fixed at `services/agent-claw/src/bootstrap/routes.ts:22,89`.
- **H7** (forge_tool path-traversal) — `forge_tool.ts:222` uses `randomUUID()` so the filename is never user-controlled.
- **L10** (no ESLint) — `services/agent-claw/eslint.config.mjs` and `services/paperclip/eslint.config.mjs` exist now.
- **M11** (compact-window ignores AbortSignal) — fixed at `compact-window.ts:56-66` (forwards `options.signal`).

### Persistent (still present from prior audit)

- **H5** — `document_chunks.byte_start` / `byte_end` columns added but never written by `doc_ingester/importer.py`. Same status; not in this merge's scope but unchanged.
- **L3** (`session_reanimator/main.py:24` stale ADR-006 TODO) — no diff observed in latest revision.
- **L4** (phase-6 permissions TODOs in `step.ts:160` and `types.ts:257`) — partial: the resolver wires up but only `chat.ts` passes `permissions: { permissionMode: "enforce" }` (see F-06 above). BACKLOG line 6 has the rest.
- **L5** (`lifecycle.ts:255` centralised pino logger TODO) — not verified in this audit; assumed unchanged.

### New regressions from the recent merges

- **F-01** SERVICE_SCOPES gap (P0) — caused by the Z1 merge adding agent builtins for two services without updating both maps.
- **F-02** Port 8015 collision (P0) — caused by Phase 5 (`mcp-genchem`) and Phase Z3 (`mcp-yield-baseline`) both picking 8015 in parallel branches.
- **F-03** workflow_engine SQL placeholders (P0) — introduced by the Phase 8 merge.
- **F-04** RLS gap on Phase 5/6/7/8 tables (P1) — introduced by the parallel-merge of those phases without cross-referencing CLAUDE.md's RLS rule.
- **F-05** Helm chart missing services (P1) — accumulated across all the Z-phase + Phase 5/6/7/8 PRs.
- **F-06** `permissionMode: "enforce"` only on `/api/chat` (P1) — pre-existing, but visibility raised by the route-split refactor.
- **F-08** Six SQL filename-prefix collisions (P2) — direct consequence of parallel-branching on the same numbering scheme.
- **F-10** Inconsistent self-INSERT into `schema_version` (P2) — caused by Phase 5/6/7/8 PRs each adopting a different convention.

---

## Verification commands

To replicate the most load-bearing findings without running the audit again:

```bash
# F-01: SERVICE_SCOPES gap
diff <(grep -oE '"mcp-[a-z-]+"' services/agent-claw/src/security/mcp-token-cache.ts | sort -u) \
     <(grep -rEn '"mcp-[a-z-]+"' services/agent-claw/src/tools/ | grep -oE '"mcp-[a-z-]+"' | sort -u)

# F-02: port collision
grep -E '^\s+- "[0-9]+:[0-9]+"' docker-compose.yml | sort | uniq -c | awk '$1>1'

# F-03: psycopg3 with $N placeholders
grep -nE '\$[1-9][^a-zA-Z]' services/workflow_engine/main.py

# F-04: RLS gap
for f in db/init/{23,24,25,26,27,28,29}_*.sql; do
  grep -L "ENABLE ROW LEVEL" "$f" || echo "$f has RLS"
done

# F-05: Helm chart missing services
diff <(awk '/^  [a-z-]+:$/{print $1}' docker-compose.yml | tr -d ':' | grep '^mcp-' | sort -u) \
     <(grep -oE 'mcp-[a-z-]+' infra/helm/templates/chemistry-deployments.yaml | sort -u)

# F-06: permissionMode coverage
grep -rn "permissionMode" services/agent-claw/src/routes/
```

---

End of report.
