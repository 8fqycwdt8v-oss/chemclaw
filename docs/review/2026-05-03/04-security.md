# Security Audit — 2026-05-03

Working tree: `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw`
Branch: `main` @ `a176276`
Read-only on code; this file is the only artefact written.

Cross-references the prior audit at
`docs/review/2026-04-29-codebase-audit/04-security-deps.md`. New findings,
regressions, and persistent issues are flagged in the
"Cross-Reference: Prior Audit" section.

---

## Executive Summary

| Severity | Finding | File:line | CWE / Class | Fix sketch |
| --- | --- | --- | --- | --- |
| **P0** | Workflow runs / events / state are NOT RLS-protected; any user can read, start, modify, replay, pause, or inspect any other user's workflow runs (including step inputs/outputs containing SMILES + compound codes) via the `workflow_*` builtins | `db/init/29_workflows.sql` (no `ENABLE RLS`); `services/agent-claw/src/core/workflows/client.ts:51-225`; `services/agent-claw/src/tools/builtins/workflow_run.ts:34-46`, `workflow_inspect.ts:58-60`, `workflow_modify.ts`, `workflow_replay.ts`, `workflow_pause_resume.ts` | CWE-285 / CWE-639 (BOLA / IDOR) | Add `ENABLE / FORCE ROW LEVEL SECURITY` on all 5 tables; switch `withSystemContext` to `withUserContext(callerId,…)` in `client.ts`; add policies that gate visibility on `created_by = current_setting('app.current_user_entra_id')` (or via session/project linkage) |
| **P1** | `workflow_engine` posts to MCP services using **psycopg `$1::text` placeholders** (asyncpg syntax); psycopg expects `%s` — every state-update + event-append query throws at runtime | `services/workflow_engine/main.py:171-178, 282-290, 301-310` | CWE-755 (avail.); not directly security but breaks the audited token-minting path | Replace `$N::type` with `%s::type`; add an integration test that actually exercises a step transition |
| **P1** | LiteLLM gateway image still pinned to **moving tag** `ghcr.io/berriai/litellm:main-v1.60.0`; affected versions ship four CVEs landed in 1.83.x (`GHSA-69x8-hrgq-fjj8`, `GHSA-xqmj-j6mv-4862`, CVE-2026-35029, CVE-2026-35030) | `services/litellm_redactor/Dockerfile:15-16` | CWE-1104 / CWE-1395 | `LITELLM_BASE_IMAGE=ghcr.io/berriai/litellm@sha256:<digest>` (a comment explains how, but the default in source is still the tag); also bump to a 1.83.x base |
| **P1** | `LocalSubprocessSandbox` runs LLM-authored Python under the validator's UID with no isolation when E2B is not wired in production | `services/optimizer/forged_tool_validator/sandbox_client.py:32-58` (carryover) | CWE-94 / CWE-915 | Refuse to import in prod (`if os.getenv("FORGED_TOOL_REQUIRE_E2B") == "true": raise`), add gateway runtime check |
| **P1** | `forge_tool` builtin issues filesystem write of `${toolId}.py` from an LLM-controlled tool-id input; recently-added `randomUUID()` reduces but does not eliminate risk if tests / external callers pass `name` through | `services/agent-claw/src/tools/builtins/forge_tool.ts:382-440` (carryover; not landed) | CWE-22 (path traversal) | Prepend `/^[a-z][a-z0-9_]{1,63}$/` allowlist on `input.name` and `toolId` before any `path.join` |
| **P1** | `LOG_USER_SALT` Python loader silently accepts dev-mode in production if `MCP_AUTH_DEV_MODE=true` OR `PYTEST_CURRENT_TEST` is set; the latter can leak into a misconfigured prod environment | `services/mcp_tools/common/user_hash.py:42-46` | CWE-327 (weak salt) / CWE-798 | Drop `PYTEST_CURRENT_TEST` from the dev-mode check; require explicit `CHEMCLAW_DEV_MODE=true` only |
| **P2** | `dynamic_patterns.py:is_pattern_safe` only forbids 7 unbounded-quantifier shapes (`.*`, `.+`, `\S+`, `\w+`, `\d+`, `\D+`, `\W+`); allows ReDoS-prone `(a+)+`, `(a|a)*`, `[a-z]+`, `[^x]*` from a malicious admin row | `services/litellm_redactor/dynamic_patterns.py:38-65`; `services/agent-claw/src/routes/admin/admin-redaction.ts:53-65` | CWE-1333 (ReDoS) | Add nested-quantifier detection (`safe-regex` library equivalent) or run a 100ms timeout when test-compiling new patterns |
| **P2** | Pino logger's redact list does **not** scrub `err.message`, `err.stack`, or top-level `*.message`; Postgres driver errors carry "Failing row contains (...)" embedding column values, MCP fetch errors carry response bodies — both regularly contain SMILES / compound codes / project-ids | `services/agent-claw/src/observability/logger.ts:48-73` (comment acknowledges deferred) | CWE-209 / CWE-532 | Mirror the Python redaction filter on the TS side: a Pino formatter / serializer that runs the same `redactString` over `msg` and `err.*` fields |
| **P2** | Python logging `RedactionFilter` excludes `exc_info` and `exc_text` (line 63 of the `_PASSTHROUGH_FIELDS` set); a Postgres exception with SMILES in the message bypasses the redactor | `services/mcp_tools/common/redaction_filter.py:62-64` | CWE-532 | Run the redactor over `record.exc_text` once it's been formatted by `Formatter.formatException`; or override the formatter to redact post-render |
| **P2** | DNS-rebinding TOCTOU in `mcp_doc_fetcher`: `validate_network_host` resolves once via `socket.getaddrinfo`, then httpx makes a second resolution at connect time — between them the DNS answer can change to a metadata IP | `services/mcp_tools/mcp_doc_fetcher/validators.py:115-155`; `fetchers.py:118-158` | CWE-918 (SSRF) | Pin the resolved IP — pass an `httpx.Transport` with `host_resolver` returning the validated IP, OR re-validate the actual remote IP in a httpx event-hook before reading the body |
| **P2** | `verifyBearerHeader` in the internal-resume route does NOT pass `expectedAudience`; tokens minted for any service (or no aud) can be replayed at `/api/internal/sessions/:id/resume` | `services/agent-claw/src/routes/sessions-handlers.ts:375-383`; `security/mcp-tokens.ts:140-220` | CWE-294 (auth-bypass / replay) | Pass `expectedAudience: "agent-claw"` (or whatever name reflects this listener); set `audience="agent-claw"` when reanimator mints |
| **P2** | `forge_tool`, `add_forged_tool_test`, `bootstrap/probes.ts`, `tools/registry.ts`, `tools/builtins/run_program.ts` all use raw `pool.query()` outside `withUserContext`/`withSystemContext`. App connects as `chemclaw_app` (NO BYPASSRLS, FORCE RLS); without context set, FORCE-RLS evaluates `current_setting('app.current_user_entra_id')` as the empty string, which the prior audit confirmed is no longer permissive — these queries either silently return zero rows or 403 in prod | `services/agent-claw/src/tools/builtins/forge_tool.ts:178-192,246-256,411-455`; `add_forged_tool_test.ts:53-80`; `tools/registry.ts:299`; `bootstrap/probes.ts:30-90`; `tools/builtins/run_program.ts:269` | CWE-863 (incorrect authorization) | Wrap every raw `pool.query` in `withUserContext(pool, ctx.userEntraId, ...)` or `withSystemContext` — same fix shape we already use 30+ times |
| **P2** | `litellm 1.82.6` in `gepa_runner` venv carries 4 CVEs; `starlette 0.48.0` in 3 services has CVE-2025-62727 (DoS via repeated multipart fields); `torch 2.2.2` in `mcp_embedder` + `mcp_tabicl` has 4 CVEs (carryover from prior audit) | `services/optimizer/gepa_runner/requirements.txt`, `services/optimizer/skill_promoter/requirements.txt`, `services/mcp_tools/mcp_tabicl/requirements.txt`, `services/mcp_tools/mcp_embedder/requirements.txt` | CWE-1395 / CWE-937 | Bump fastapi → 0.118+ (pulls starlette 0.49.x); bump litellm → 1.83.7+; bump torch → 2.6.0+ at next image rebuild |
| **P3** | `fetch_https` accepts redirect to a host that is NOT in the deny list but resolves to RFC1918 only when `ALLOW_HOSTS` is empty (the resolution is still re-validated, but the rebind window is reachable on every redirect) | `services/mcp_tools/mcp_doc_fetcher/fetchers.py:118-139`; `validators.py:144-155` | CWE-918 | Same as P2 above (pin the resolved IP through the redirect) |
| **P3** | `admin-permissions.ts:102` builds `new RegExp(argument_pattern)` from a user-supplied string with no bounded-quantifier check; admin-redaction.ts has the check but admin-permissions.ts does not | `services/agent-claw/src/routes/admin/admin-permissions.ts:100-106` | CWE-1333 | Reuse the same `isPatternSafe` helper from `admin-redaction.ts:53-65` here |
| **P3** | CORS allows `null` origin (curl, server-to-server) with `credentials: true`; an attacker controlling an intermediate that strips Origin can carry user cookies to chemclaw | `services/agent-claw/src/bootstrap/server.ts:48-55` | CWE-942 / CWE-352 | Reject `!origin` requests for credentialed routes, OR require X-Requested-With on `/api/*` |
| **P3** | Public `/api/sessions/:id/resume` reads `x-user-entra-id` from the header and trusts it; CLAUDE.md says agent-claw sits behind an auth proxy, but a misconfigured deploy with the port exposed is fully forgeable | `services/agent-claw/src/routes/sessions-handlers.ts:318-345` (carryover) | CWE-290 (header-trust) / CWE-285 | Eventually admin-gate this route behind `requireAdmin` and force callers to use `/api/internal/...` with a JWT |
| **P3** | Reanimator mints JWTs without an `audience` claim — the route doesn't currently check `aud`, but defense-in-depth would have us bind tokens to `agent-claw` | `services/optimizer/session_reanimator/main.py:191-198`; the verifier path in `sessions-handlers.ts:375` | CWE-294 (replay) | `audience="agent-claw"` on the mint, `expectedAudience="agent-claw"` on the verify (paired with P2 above) |
| **P3** | `non-literal RegExp` in `lifecycle.ts:90`, `policy-loader.ts:108` from operator hook YAML / DB rows; operator-controlled, not user-controlled (carryover) | as listed | CWE-1333 | Add a one-time `isPatternSafe` check at hook-load / policy-load |
| **P3** | `diskcache 5.6.3` (`CVE-2025-69872` unsafe deserialisation); fix not yet released in 5.x branch (carryover) | `services/optimizer/gepa_runner/requirements.txt` (transitive) | CWE-502 | Track upstream; consider pinning to a commit if 5.7 doesn't ship |
| **P3** | Dev `.venv` has `setuptools 65.5.0` with 5 advisories (PYSEC-2022-43012, PYSEC-2025-49, CVE-2024-6345); not in any service Dockerfile (carryover) | local dev environment | CWE-937 | `pip install -U setuptools` in the dev venv |

**Counts**: 1 P0, 6 P1, 8 P2, 7 P3 (carryover items inherited from 2026-04-29 are individually flagged). Net change: 1 new P0 (workflow RLS), 1 P1 regression (workflow_engine SQL placeholder bug), 1 fixed P1 (litellm_redactor Dockerfile USER), 1 fixed P2 (npm uuid via testcontainers).

---

## Full Appendix

### F-1 [P0] Workflow tables / runs are not RLS-isolated; cross-tenant read+write via the `workflow_*` builtins

**Files**:
- `db/init/29_workflows.sql:1-153` — defines `workflows`, `workflow_runs`, `workflow_events`, `workflow_state`, `workflow_modifications` and grants `SELECT, INSERT, UPDATE` on all five to `chemclaw_app`. **No `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and no `CREATE POLICY` clauses anywhere in the file.**
- `services/agent-claw/src/core/workflows/client.ts:51, 84, 110, 146, 157, 175, 206` — every workflow operation runs inside `withSystemContext(pool, async (client) => ...)`, which sets `app.current_user_entra_id = '__system__'`. The `created_by` column is populated as a string but no RLS reads it.
- `services/agent-claw/src/tools/builtins/workflow_inspect.ts:58-60` — `inspectRun(pool, input.run_id, ...)` is called with NO check that `ctx.userEntraId` matches `created_by`.
- `services/agent-claw/src/tools/builtins/workflow_run.ts:34-46` — `startRun(pool, input.workflow_id, input.input ?? {}, actor, ...)` will start a run on any `workflow_id` the caller can name; subsequent runs are then accessible to anyone via `workflow_inspect`.
- `db/init/29_workflows.sql:136-143` — the permission_policies seed sets `decision='allow'` globally for `workflow_define`, `workflow_run`, `workflow_inspect`, and `decision='ask'` for `workflow_pause_resume`, `workflow_modify`, `workflow_replay`. So the only gate is "the agent's permission resolver allowed it" — and the resolver does NOT compare actor to `created_by`.

**Evidence (workflow_inspect.ts)**:
```ts
execute: async (_ctx, input) => {
  return await inspectRun(pool, input.run_id, input.event_limit ?? 50);
},
```

**Evidence (client.ts:108-142, inspectRun)**:
```ts
return await withSystemContext(pool, async (client) => {
  const runRes = await client.query<WorkflowRunRecord>(
    `SELECT … FROM workflow_runs WHERE id = $1::uuid`,
    [runId],
  );
  …
  const eventsRes = await client.query<WorkflowEventRecord>(
    `SELECT … FROM workflow_events WHERE run_id = $1::uuid ORDER BY seq DESC LIMIT $2`,
    [runId, eventLimit],
  );
  return { run, state: stateRes.rows[0] ?? null, events: eventsRes.rows.reverse() };
});
```

**Threat model**: Any authenticated user (multi-tenant pharma chemists across NCE projects) calls `workflow_inspect` with a run_id they discover (incrementing UUIDs unlikely, but enumeration via `workflow_runs.session_id` linkage from a shared `agent_sessions` view would work; or simply guessing UUIDs from leaked logs). They get back `payload` JSON for every step, which includes the **tool inputs** the original user passed — SMILES strings, compound codes, NCE project ids, free-text reaction context, calibration data joins. `workflow_run` lets them start fresh runs charging the original definition's owner. `workflow_modify` rewrites a paused workflow's remaining plan (the `ask` policy stops the agent's automatic call but a directly-issued `/api/chat` "please modify run X" works). `workflow_replay` re-executes any historical run.

**Impact**: Cross-tenant data leak (chemistry IP), arbitrary cross-user resource consumption (LLM costs, MCP CPU), tampering with another user's running workflow (modify rewrites the plan).

**Fix sketch**:

1. SQL — turn on RLS on every workflow table:
```sql
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows FORCE ROW LEVEL SECURITY;
CREATE POLICY workflows_owner_select ON workflows FOR SELECT
  USING (created_by = current_setting('app.current_user_entra_id', true)
         OR current_setting('app.current_user_entra_id', true) = '__system__');
CREATE POLICY workflows_owner_insert ON workflows FOR INSERT
  WITH CHECK (created_by = current_setting('app.current_user_entra_id', true));
-- repeat for workflow_runs, workflow_events (gate via run_id → workflow_runs.created_by),
-- workflow_state, workflow_modifications.
```

2. TS — switch `withSystemContext` → `withUserContext(pool, callerId, …)` in client.ts; the optimizer / queue / workflow-engine continue to connect as `chemclaw_service` (BYPASSRLS) so they're unaffected.

3. Builtin authorization — in `workflow_inspect`, `workflow_run`, `workflow_modify`, `workflow_replay`, `workflow_pause_resume`, fetch `workflow_runs.created_by` and 403 if `!== ctx.userEntraId` (or do it via RLS — preferred).

**Suggested test**:
```
- Create workflow A as user U1.
- Start a run R1 of workflow A as U1; capture the run_id.
- As user U2 (different entra-id), call workflow_inspect({run_id: R1}). Expect 0 rows / 403.
- As U2, call workflow_run({workflow_id: A.id, input: {…}}). Expect 0 rows / 403.
- As U2, call workflow_modify({run_id: R1, …}). Expect failure.
```

---

### F-2 [P1] `workflow_engine` uses asyncpg `$1::text` placeholders against psycopg connections — every step-transition / event-append throws at runtime

**File**: `services/workflow_engine/main.py:168-178, 280-290, 300-310`.

**Evidence (lines 168-179)**:
```py
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

`work_conn` is opened via `psycopg.AsyncConnection.connect(self.settings.dsn, …)` (line 91-93). psycopg's parameter style is `%s` — `$1::text` is a Postgres prepared-statement placeholder used by asyncpg, not psycopg. Same shape repeated in `_finish` (lines 300-310) and `_append_event` (lines 280-290).

**Threat model**: Not directly a security issue, but it means the workflow engine **cannot have run successfully in any test that exercises a real step transition**. The token-minting wiring added in commit `e2bed06` is unverifiable in production until this is fixed — the engine throws before it ever reaches the MCP HTTP call.

**Fix**: replace `$N::type` with `%s::type`. A 30-second test that calls `_advance_run` against a Postgres testcontainer with a one-step `tool_call` definition would have caught this.

**Suggested test**: integration test that posts a workflow + run via the public agent-claw routes (after F-1 RLS lands), waits 5 s, asserts the run completed.

---

### F-3 [P1] LiteLLM gateway base image still pinned to a moving tag — no digest

**File**: `services/litellm_redactor/Dockerfile:14-16`.

**Evidence**:
```
ARG LITELLM_BASE_IMAGE=ghcr.io/berriai/litellm:main-v1.60.0
FROM ${LITELLM_BASE_IMAGE}
```

The comment above (lines 7-14) tells the operator how to pin to a digest at build time, but the **default** is still a moving tag. A CI rebuild today gets whatever `main-v1.60.0` resolves to today; tomorrow the same Dockerfile builds a different gateway image without a code change.

**Threat model**: supply-chain. Upstream re-pushes the tag, the LiteLLM proxy ships a different binary with potentially different (or lost) protections. Carryover from the 2026-04-29 audit; not closed.

**Affected version**: 1.60.0 carries 4 advisories patched in 1.83.x (`GHSA-69x8-hrgq-fjj8`, `GHSA-xqmj-j6mv-4862`, CVE-2026-35029, CVE-2026-35030 — see "Supply-chain Findings" below).

**Fix**: change the `ARG` default to a sha256 digest pulled from `docker buildx imagetools inspect ghcr.io/berriai/litellm:main-v1.83.7` (or whichever version is current and patched). Ideally bump the base to 1.83.x at the same time.

**Suggested test**: a CI job that fails when the base image arg is a tag rather than a `@sha256:` reference.

---

### F-4 [P1] `LocalSubprocessSandbox` runs LLM-authored Python under the validator's UID with no isolation if E2B is not wired in production

**File**: `services/optimizer/forged_tool_validator/sandbox_client.py:32-58` (carryover from 2026-04-29 — not landed).

The class docstring explicitly says *"NOT isolated. Use E2B in production."*; the swap is via a `Protocol` that an operator must wire, but there's no runtime guard that **forces** E2B in production — see prior audit text. Mitigation 1 from the prior audit (raise on import in production) is the cleanest fix and remains unimplemented.

**Fix**:
```py
if os.environ.get("CHEMCLAW_DEV_MODE", "").lower() != "true":
    raise RuntimeError(
        "LocalSubprocessSandbox is dev-only; refusing to import in production. "
        "Set CHEMCLAW_DEV_MODE=true or wire the E2BSandbox in make_validator()."
    )
```

at the top of `LocalSubprocessSandbox.__init__`.

---

### F-5 [P1] `forge_tool` filesystem write of `${toolId}.py` from LLM-controlled input

**File**: `services/agent-claw/src/tools/builtins/forge_tool.ts:382-440` (carryover; partially mitigated by `randomUUID()` at line 222 but the underlying tool **name** is still LLM-controlled and propagates into DB rows + later filesystem operations).

The prior audit's recommended fix — an explicit `/^[a-z][a-z0-9_]{1,63}$/` allowlist on `input.name` and `toolId` before any `path.join` — has not been added. `randomUUID()` is used as the database key but `input.name` (line 230) still flows into `skill_library.name`, which is then referenced by `tools.name`, which feeds invocation routing. A protected-tool-name guard (line 227) catches `forge_tool` and `run_program` but doesn't reject `../../etc/passwd`-style strings.

**Fix**:
```ts
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
if (!NAME_RE.test(input.name)) {
  throw new Error(`forge_tool: name must match ${NAME_RE} (got ${JSON.stringify(input.name)})`);
}
```

inserted before the protected-name check.

---

### F-6 [P1] `LOG_USER_SALT` Python loader silently accepts `PYTEST_CURRENT_TEST` as a dev-mode signal in production

**File**: `services/mcp_tools/common/user_hash.py:42-46`.

**Evidence**:
```py
is_dev = (
    os.getenv("CHEMCLAW_DEV_MODE", "").lower() == "true"
    or os.getenv("MCP_AUTH_DEV_MODE", "").lower() == "true"
    or os.getenv("PYTEST_CURRENT_TEST") is not None
)
```

`PYTEST_CURRENT_TEST` is set by pytest while a test runs. If a misconfigured production container runs pytest at startup (some CI smoke harnesses do), or if a developer's `.env` accidentally inherits it, the salt silently falls back to the public dev salt and the 16-hex-char user hash becomes rainbow-table-reversible against any pharmaceutical-org email list.

The TypeScript mirror (line 45) only checks `CHEMCLAW_DEV_MODE === "true"`. The Python side should match.

**Fix**: drop the `PYTEST_CURRENT_TEST` clause; pytest fixtures explicitly set `CHEMCLAW_DEV_MODE=true` (the conftest already does this for MCP auth dev-mode).

---

### F-7 [P2] `is_pattern_safe` does not catch nested-quantifier ReDoS

**Files**: `services/litellm_redactor/dynamic_patterns.py:38-65`; mirror at `services/agent-claw/src/routes/admin/admin-redaction.ts:53-65`.

**Evidence**:
```py
_UNBOUNDED_QUANT = re.compile(
    r"(?<!\\)(?:\.\*|\.\+|\\S\+|\\w\+|\\d\+|\\D\+|\\W\+)(?!\?\{)"
)
```

This rejects 7 specific shapes. A malicious admin (or a compromised admin token) inserts a row with `pattern_regex='(a+)+$'` — passes both the DB CHECK (`length ≤ 200`) and `is_pattern_safe` (no `.*` / `.+` / `\S+`), then catastrophic-backtracks on any string of `a`s.

**Threat model**: Limited — requires admin role to insert the row. But the redactor runs on every LLM call, so a single bad row stalls every prompt egress. Privilege-escalation surface from "compromised admin account" to "denial of service across all tenants".

**Fix**: pre-compile and run the candidate regex against a 100ms-bounded fuzz string before accepting:
```py
import re, signal
def is_pattern_safe(raw):
    # … existing checks …
    try:
        compiled = re.compile(raw)
    except re.error as exc:
        return False, f"re.compile failed: {exc}"
    # Fuzz-test for ReDoS.
    fuzz = "a" * 1000 + "!"
    def alarm(*_): raise TimeoutError()
    old = signal.signal(signal.SIGALRM, alarm)
    signal.setitimer(signal.ITIMER_REAL, 0.1)
    try:
        compiled.search(fuzz)
    except TimeoutError:
        return False, "pattern is catastrophic on adversarial input"
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)
    return True, None
```

(Or vendor `safe-regex2` / `re2` — re2 forbids backtracking by construction.)

---

### F-8 [P2] Pino redact list does not scrub `err.message` / `err.stack`

**File**: `services/agent-claw/src/observability/logger.ts:48-73`.

**Evidence (comment at lines 65-72)**:
```
// We deliberately do NOT redact `err.message` / `err.stack` — those are
// diagnostic and an operator triaging a production incident needs them.
```

The TS-side has no full LiteLLM-redactor analogue (the comment acknowledges the gap and says it's deferred). Postgres driver errors carry the failing row's column values literally embedded ("Failing row contains (smiles=CC(=O)..., compound_code=CMP-12345)"); MCP fetch errors carry the upstream response body in `err.message` when the body is short; the `await pool.query(...)` failure paths at the 100+ raw `pool.query` callsites all flow into Pino as `{err: theError}`.

**Threat model**: SMILES, compound codes, NCE-IDs in stack traces shipped to Loki / Grafana, accessible to anyone with logs read access (operations team, SOC, sometimes contractors).

**Fix**: write a Pino formatter that runs `redactString` (the `redact-secrets.ts` helper) over every `err.message`, `err.stack`, and `*.message` field. The existing `redact-secrets.ts` exports `redactString` for this exact reuse case.

**Suggested test**:
```
const log = getLogger("test");
log.error({err: new Error("INSERT failed: SMILES CC(=O)O")}, "test");
expect(stderr).not.toContain("CC(=O)O");
```

---

### F-9 [P2] Python `RedactionFilter` excludes `exc_info` / `exc_text`

**File**: `services/mcp_tools/common/redaction_filter.py:62-64`.

The `_PASSTHROUGH_FIELDS` set lists `exc_info`, `exc_text`, `stack_info`. So `log.exception(...)` (which is the standard pattern in `services/projectors/*/main.py` and `services/queue/worker.py`) ships exception messages and tracebacks to Loki without any redaction.

**Threat model**: same as F-8 — Postgres driver errors carry column values in `exc_text`.

**Fix**:
```py
# After existing field redactions:
if record.exc_info or record.exc_text:
    if not record.exc_text:
        record.exc_text = logging.Formatter().formatException(record.exc_info)
    record.exc_text = _redact(record.exc_text)
    # Drop exc_info — exc_text now has the redacted version.
    record.exc_info = None
```

---

### F-10 [P2] DNS-rebinding TOCTOU in `mcp_doc_fetcher`

**Files**: `services/mcp_tools/mcp_doc_fetcher/validators.py:115-155`; `fetchers.py:118-158`.

**Evidence (validators.py:144-147)**:
```py
try:
    infos = socket.getaddrinfo(h, None)
except socket.gaierror as exc:
    raise ValueError(f"host {host!r} did not resolve: {exc}") from exc
```

`getaddrinfo` is called once. httpx then opens the TCP connection itself, which does its own DNS lookup. The two answers can differ — a malicious authoritative DNS server returns 1.2.3.4 (passes validation), then 169.254.169.254 (cloud metadata) on the second query.

**Threat model**: SSRF to AWS / GCP / Azure metadata endpoints to lift IAM credentials — the canonical SSRF chain. Lower probability with the `BLOCKED_NETWORKS` re-validation on redirects, but the initial-request connect race remains exposed.

**Fix**: pass an explicit `httpx.Transport` whose `host_resolver` returns only the IP we just validated. Alternatively, switch to `httpx`'s `trust_env=False` + a custom resolver that caches the validation result. The `ssrf-req-filter` library (Node) and `defusedhttp` / `requests-ip-rotator`-style explicit-IP transports are the established defenses.

**Concrete sketch**:
```py
import httpx, socket
infos = socket.getaddrinfo(host, None)
ip = infos[0][4][0]
if ip_is_blocked(ip): raise ValueError(...)
transport = httpx.HTTPTransport(local_address=None, retries=0)
# httpx 0.28+: pass a custom resolver via host = ip in URL,
# preserving the original Host header.
url2 = uri.replace(host, ip, 1)  # naive — better: use httpx's resolver hook
response = client.get(url2, headers={"Host": host})
```

---

### F-11 [P2] `verifyBearerHeader` in internal-resume route does not pass `expectedAudience`

**Files**: `services/agent-claw/src/routes/sessions-handlers.ts:375-383`; verifier at `services/agent-claw/src/security/mcp-tokens.ts:140-220`.

**Evidence (sessions-handlers.ts:375)**:
```ts
const claims = verifyBearerHeader(typeof authz === "string" ? authz : undefined, {
  requiredScope: "agent:resume",
});
```

No `expectedAudience` is set. The verifier accepts a token with any `aud` (or no `aud`).

The reanimator (`services/optimizer/session_reanimator/main.py:191-198`) does not set `audience=` when minting either, so the token has no aud claim — but the lack of audience-binding **everywhere** means the same reanimator JWT could be replayed against any future internal route the agent grows that also uses `verifyBearerHeader` without an `expectedAudience`.

**Fix**:
- Reanimator: add `audience="agent-claw"` (or whatever the agent service name is) to `sign_mcp_token`.
- Internal route: pass `expectedAudience: "agent-claw"` to `verifyBearerHeader`.
- Cycle in: when adding new `/api/internal/*` routes, declare an `expectedAudience` per route — same pattern as MCP services pass `name` to `make_require_mcp_token`.

---

### F-12 [P2] Raw `pool.query()` outside `withUserContext` / `withSystemContext`

**Files**:
- `services/agent-claw/src/tools/builtins/forge_tool.ts:178-192, 246-256, 411-455`
- `services/agent-claw/src/tools/builtins/add_forged_tool_test.ts:53-80`
- `services/agent-claw/src/tools/registry.ts:299`
- `services/agent-claw/src/tools/builtins/run_program.ts:269`
- `services/agent-claw/src/bootstrap/probes.ts:30-90`

**Evidence (forge_tool.ts:178-192)**:
```ts
async function toolNameExists(pool: Pool, name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM tools WHERE name = $1) AS exists`,
    [name],
  );
  return rows[0]?.exists ?? false;
}
```

Agent-claw connects as `chemclaw_app` (NO BYPASSRLS, FORCE RLS) — see `db/pool.ts:6` and `config.ts:60-65`. Without `app.current_user_entra_id` being set, FORCE-RLS sees an empty / NULL setting; the policies in `db/init/12_security_hardening.sql` were rewritten in the prior cycle to require a non-empty value. So these queries either return zero rows or fail outright in a properly-locked-down deployment.

**Threat model**: not a leak per se — RLS makes them silently empty rather than over-permissive. But it's a class of bugs that **should** turn into hard failures; right now they degrade gracefully and the agent silently misbehaves.

**Fix**: wrap each in `withUserContext(pool, ctx.userEntraId, …)` (when a user context is in scope) or `withSystemContext(pool, …)` (when the query reads global catalog-style data). See the 30+ existing call sites for the pattern.

**Suggested test**: a startup smoke that sets `chemclaw_app` as the connection role and runs `runProbe(...)` — should not silently pass when the env is broken.

---

### F-13 [P2] Vulnerable Python deps (carryover)

See "Supply-chain Findings" table below. Same set as the 2026-04-29 audit; nothing has been bumped.

---

### F-14 [P3] Redirect-time RFC1918 race

Sub-finding of F-10. Each redirect re-runs `validate_network_host`, which has the same DNS-rebinding TOCTOU. Same fix.

---

### F-15 [P3] `admin-permissions.ts` builds RegExp from user input without bounded-quantifier check

**File**: `services/agent-claw/src/routes/admin/admin-permissions.ts:100-106`.

```ts
if (argument_pattern) {
  try {
    new RegExp(argument_pattern);
  } catch (e) {
    return await reply.status(400).send({ error: `Invalid argument_pattern regex: ${(e as Error).message}` });
  }
}
```

This validates regex syntax but doesn't reject `(a+)+` / `(a|a)*`. An admin (or an attacker who phishes an admin token) inserts a permission policy with an `argument_pattern` that's catastrophic; every tool call that triggers that policy then stalls. The redaction route (`admin-redaction.ts:53-65`) uses `isPatternSafe()` for the same purpose.

**Fix**: lift `isPatternSafe` to a shared helper and use it here too.

---

### F-16 [P3] CORS allows `null` origin with `credentials: true`

**File**: `services/agent-claw/src/bootstrap/server.ts:48-55`.

```ts
await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) { cb(null, true); return; } // curl / server-to-server
    …
  },
  credentials: true,
});
```

Allowing `!origin` with `credentials: true` is unusual. Server-to-server callers don't need CORS credentials, and a forwarding intermediate that strips Origin can carry user cookies cross-origin to chemclaw.

**Fix**: when the request path matches `/api/*` and `credentials` matters, reject `!origin`. Browser-side curl-equivalent flows should not need cookies.

---

### F-17 [P3] Public `/api/sessions/:id/resume` trusts `x-user-entra-id` header

**File**: `services/agent-claw/src/routes/sessions-handlers.ts:318-345` (carryover).

The route comment (line 313-315) acknowledges *"No admin gate here yet — operators control access via the cron's own service role and an internal-only listener; if we expose this publicly it'll need an `admin` role check"*. As long as an external auth proxy is in front, it's fine — but an exposed port (dev, misconfig) gives the caller forge-able user identity.

The internal route at `/api/internal/sessions/:id/resume` (verifies a JWT) is the right path forward; eventually retire the public path.

---

### F-18 [P3] Reanimator mints tokens without `audience`

Already covered by F-11.

---

### F-19 [P3] `lifecycle.ts` non-literal RegExp from operator hook YAML / DB

Carryover. Same fix shape: `isPatternSafe` at hook-load.

---

### F-20 [P3] `diskcache 5.6.3` (CVE-2025-69872)

Carryover, no upstream fix released.

---

### F-21 [P3] Dev `.venv` setuptools 65.5.0

Carryover, dev-only.

---

## Supply-chain Findings

### npm

```
npm audit (root)                         → 0 vulnerabilities (was 4 moderate)
cd services/agent-claw && npm audit      → 0 vulnerabilities (was 4 moderate)
cd services/paperclip && npm audit       → 0 vulnerabilities
```

The `uuid` advisory via `testcontainers` → `dockerode` (`GHSA-w5hq-g745-h8pq`) flagged in the 2026-04-29 audit is **resolved** — `package-lock.json` confirms `uuid@14` in the testcontainers dependency tree.

### Python

`pip-audit -r <requirements.txt> --no-deps`:

| Package | Current | Advisory | Severity | Fix Version | Service |
|---|---|---|---|---|---|
| `starlette` | 0.48.0 | CVE-2025-62727 | Moderate (DoS) | 0.49.1 | `gepa_runner`, `skill_promoter`, `mcp_tabicl` |
| `litellm` | 1.82.6 | CVE-2026-35029 | High | 1.83.0 | `gepa_runner` venv |
| `litellm` | 1.82.6 | CVE-2026-35030 | High | 1.83.0 | `gepa_runner` venv |
| `litellm` | 1.82.6 | GHSA-69x8-hrgq-fjj8 | Moderate | 1.83.0 | `gepa_runner` venv |
| `litellm` | 1.82.6 | GHSA-xqmj-j6mv-4862 | Moderate | 1.83.7 | `gepa_runner` venv |
| `diskcache` | 5.6.3 | CVE-2025-69872 | Low (sandbox-required) | (5.x not fixed) | `gepa_runner` (transitive) |
| `torch` | 2.2.2 | PYSEC-2025-41, PYSEC-2024-259, CVE-2025-2953, CVE-2025-3730 | High (4 CVEs) | 2.6.0+ / 2.8.0 | `mcp_embedder`, `mcp_tabicl` |
| **`litellm` gateway** | **1.60.0 (moving tag!)** | same 4 as venv | High | 1.83.7 + digest | `services/litellm_redactor/Dockerfile:15` |

The LiteLLM gateway is the **single LLM-egress chokepoint**; pinning it to a moving tag of an old major is the highest-impact fix.

### Container base images

- `litellm_redactor/Dockerfile`: USER 1001 directive **added** since the prior audit (regression resolved).
- All other service Dockerfiles still UID 1001 per prior audit's spot-check.

---

## Cross-Reference: Prior Audit (2026-04-29)

| Prior ID | Severity | Status |
|---|---|---|
| F-1: RXN_SMILES backtracking | P1 | **FIXED** — `redaction.py:127-128` now pre-gates on `text.count(">") >= 2` and `redact-secrets.ts:79-89` mirrors with `indexOf` checks. Adversarial fuzz no longer applies to the bounded-quantifier scan. |
| F-2: LiteLLM moving tag | P1 | **PERSISTENT** (this audit's F-3). |
| F-3: LocalSubprocessSandbox | P1 | **PERSISTENT** (this audit's F-4). No runtime gate. |
| F-4: litellm_redactor Dockerfile USER | P1 | **FIXED** — `Dockerfile:30-32` now adds `useradd -u 1001` and `USER 1001`. |
| F-5: forge_tool path-traversal | P2 | **PARTIALLY MITIGATED** (this audit's F-5) — UUID added for the file-path component but `input.name` still LLM-controlled. |
| F-6: uuid via testcontainers | P2 | **FIXED** — `npm audit` clean. |
| F-7: starlette 0.48.0 | P2 | **PERSISTENT**. |
| F-8: torch 2.2.2 | P2 | **PERSISTENT**. |
| F-9: litellm 1.82.6 | P2 | **PERSISTENT**. |
| F-10: lifecycle.ts non-literal RegExp | P3 | **PERSISTENT**. |
| F-11: diskcache 5.6.3 | P3 | **PERSISTENT** (no upstream fix). |
| F-12: reanimator x-user-entra-id fallback | P3 | **PERSISTENT** (this audit's F-17). |
| F-13: dev venv setuptools | P3 | **PERSISTENT**. |

**New since 2026-04-29**:
- **F-1 (P0)**: workflow tables have no RLS — landed via `db/init/29_workflows.sql` in commit `c72dd92` ("feat(mcp-xtb): route /conformer_ensemble through the workflow engine") and PR #80. The whole workflow surface (`workflow_define`, `workflow_run`, `workflow_inspect`, `workflow_modify`, `workflow_replay`, `workflow_pause_resume`) is cross-tenant-readable.
- **F-2 (P1)**: `workflow_engine/main.py` mixes asyncpg `$N` placeholder syntax with psycopg connections; the engine throws on the first state-update.
- **F-6 (P1)**: `user_hash.py` accepts `PYTEST_CURRENT_TEST` as a dev-mode signal — not present in the TS mirror; can leak the public dev salt into prod hashes.
- **F-8 (P2)**: TS Pino logger explicitly defers `err.message` / `err.stack` redaction; the Python side mostly redacts but the carve-out for `exc_info` / `exc_text` is the same gap on a different surface (F-9).
- **F-10 (P2)**: DNS-rebinding TOCTOU in mcp-doc-fetcher — host validated once, httpx connects separately.
- **F-11 (P2)**: `verifyBearerHeader` audience binding missing in the internal-resume route.
- **F-12 (P2)**: 5 newly-reviewed call sites still use raw `pool.query` — stayed undetected because RLS makes them empty rather than 500.
- **F-15 (P3)**: `admin-permissions.ts` regex compile lacks `isPatternSafe`.
- **F-16 (P3)**: CORS `!origin` permits credentialed traffic.

**Carryovers fixed this cycle**: F-1, F-4, F-6 of the prior audit (RXN_SMILES gating, litellm Dockerfile USER, uuid advisory).

---

## Positive Security Controls Observed

- **MCP auth fail-closed default holds**: `_require_or_skip()` (`auth.py:212-229`) defaults to enforce; `MCP_AUTH_DEV_MODE=true` is the only escape hatch and it must be explicit. Routes no longer need the defensive `if claims is None: deny` shape — middleware rejects before the route runs.
- **MCP audience binding always-on for tokens**: `app.py:208` passes `expected_audience=name` even in dev mode when a token is presented. Cross-service replay closed regardless of env posture.
- **HS256-only**: `auth.py:172` and `mcp-tokens.ts:182` reject any other alg, including `none`.
- **Constant-time signature compare**: `hmac.compare_digest` (Python) and `timingSafeEqual` (TS) on both ends.
- **32-char signing key floor**: enforced at sign-time (`auth.py:104-108`, `mcp-tokens.ts:87-92`) AFTER `.strip()` so "32 spaces" is rejected.
- **5-minute TTL**: bounded; no code path mints an unbounded token.
- **LLM egress chokepoint intact**: `grep -r "from openai\|import openai\|@anthropic-ai/sdk\|@ai-sdk/anthropic\|api.openai.com\|api.anthropic.com" services/` returns nothing outside `services/litellm/config.yaml` and the `@ai-sdk/openai-compatible` provider that points at the LiteLLM proxy.
- **Redactor regex catalog bounded**: every quantifier has an explicit upper bound; new `text.count(">") >= 2` pre-gate makes the RXN_SMILES pattern fast on prose.
- **DB-pattern safety rails (partial)**: length ≤ 200 enforced both at DB CHECK and `is_pattern_safe`; common unbounded shapes rejected (with the F-7 caveat).
- **Cypher label/predicate allowlist**: strict regex (`^[A-Z][A-Za-z0-9_]{0,79}$`) defends `mcp_kg/cypher.py` against label-injection.
- **SSRF defense in `mcp_doc_fetcher`**: scheme allowlist (no s3/smb/sharepoint wired), `BLOCKED_NETWORKS` covers RFC1918, link-local incl. cloud metadata 169.254.169.254, IPv6 loopback, IPv6 unique-local; IPv4-mapped IPv6 normalisation closes a known bypass; manual redirect handling re-validates each hop. Only F-10 / F-14 (DNS-rebinding TOCTOU) remain.
- **`file://` jail off by default**: `MCP_DOC_FETCHER_FILE_ROOTS` empty → all reads refused. Symlink escape protected by `Path.resolve(strict=True)` BEFORE the containment check.
- **`fail-loud on unknown service`**: `mcp-token-cache.ts:90-97` throws when a service is missing from `SERVICE_SCOPES`. Prior implementation silently issued an unscoped token that then 403'd in production — this catches the typo at mint time.
- **`/api/internal/sessions/:id/resume` trusts JWT only**: handler reads identity from `claims.user`, not from `x-user-entra-id` (sessions-handlers.ts:362-410).
- **Helmet, CORS allowlist, per-IP/per-user rate limit** all wired in `bootstrap/server.ts`.
- **`requireAdmin` / `guardAdmin` / `appendAudit` pattern** consistently applied across `routes/admin/*.ts`. The `current_user_is_admin` SECURITY DEFINER helper avoids RLS recursion on the admin_roles table itself.
- **Forge-tool hash-on-disk integrity**: `forge_tool.ts:386-390` writes a sha256 of the source code to `skill_library.code_sha256`; `tools/registry.ts` re-checks at every load to detect post-write tampering.
- **Workflow events trigger NOTIFY** (`29_workflows.sql:76-86`) — the projector / engine pattern is event-sourced, so a forensic replay is feasible once the F-1 RLS hole is closed.
- **Per-route rate-limit on chained sessions endpoints** (`sessions.ts:58-67`): `plan/run` and `resume` capped at 1/4 of the chat rate to bound auto-resume runaway.

---

## Appendix A — Tools and command lines used

- `semgrep --config=auto services/ --json --quiet --timeout=60` (semgrep 1.142.x at `/Users/robertmoeckel/.local/bin/semgrep`) — 23 findings, 1 error. Output at `/tmp/semgrep_2026-05-03.json`.
- `npm audit --json` (root, services/agent-claw, services/paperclip).
- `.venv/bin/pip-audit -r <requirements.txt> --no-deps`.
- `git log --oneline -30`, `git show --stat e2bed06`.
- `grep -rn -E "(from openai|import openai|from anthropic|import anthropic|@anthropic-ai/sdk|@ai-sdk/anthropic|api\.openai\.com|api\.anthropic\.com)" services/`.
- `grep -rn "withUserContext\|withSystemContext\|pool\.query" services/agent-claw/src/`.
- `grep -rn "ENABLE ROW\|FORCE.*RLS" db/init/29_workflows.sql` → 0 hits.
- Read tool against every flagged source file to confirm context.

---

End of 2026-05-03 security review.
