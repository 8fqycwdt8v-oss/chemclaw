# Track F — Architectural Boundary Audit

**Date:** 2026-04-29
**Reviewer:** Track F (code-reviewer)
**Scope:** Hook lifecycle parity, singleton coverage, RLS wrapping, internal JWT trust, MCP middleware coverage, hook callback shapes, decision aggregation, timeout constant.

---

## 1. Three-Way Hook Parity Check

| Hook name | YAML file | TS impl export | BUILTIN_REGISTRARS entry | Status |
|---|---|---|---|---|
| `redact-secrets` | `hooks/redact-secrets.yaml` (`post_turn`) | `registerRedactSecretsHook` | `["redact-secrets", (lc) => registerRedactSecretsHook(lc)]` | PASS |
| `tag-maturity` | `hooks/tag-maturity.yaml` (`post_tool`) | `registerTagMaturityHook` | `["tag-maturity", (lc, deps) => registerTagMaturityHook(lc, deps.pool)]` | PASS |
| `budget-guard` | `hooks/budget-guard.yaml` (`pre_tool`) | `registerBudgetGuardHook` | `["budget-guard", (lc) => registerBudgetGuardHook(lc)]` | PASS |
| `init-scratch` | `hooks/init-scratch.yaml` (`pre_turn`) | `registerInitScratchHook` | `["init-scratch", (lc) => registerInitScratchHook(lc)]` | PASS |
| `anti-fabrication` | `hooks/anti-fabrication.yaml` (`post_tool`) | `registerAntiFabricationHook` | `["anti-fabrication", (lc) => registerAntiFabricationHook(lc)]` | PASS |
| `foundation-citation-guard` | `hooks/foundation-citation-guard.yaml` (`pre_tool`) | `registerFoundationCitationGuardHook` | matches | PASS |
| `source-cache` | `hooks/source-cache.yaml` (`post_tool`) | `registerSourceCacheHook` | matches | PASS |
| `compact-window` | `hooks/compact-window.yaml` (`pre_compact`) | `registerCompactWindowHook` | matches | PASS |
| `apply-skills` | `hooks/apply-skills.yaml` (`pre_turn`) | `registerApplySkillsHook` | matches | PASS |
| `session-events` | `hooks/session-events.yaml` (`session_start`) | `registerSessionEventsHook` | matches | PASS |
| `permission` | `hooks/permission.yaml` (`permission_request`) | `registerPermissionHook` | matches | PASS |

**Result: No orphans.** All 11 hooks present in all three columns; lifecycle phases match between YAML and the registrar's `lifecycle.on(phase, ...)` calls.

---

## 2. MIN_EXPECTED_HOOKS Reality Check

**Value:** `MIN_EXPECTED_HOOKS = 11` at `services/agent-claw/src/index.ts:484`.
**Comment:** `// 11 = 9 pre-rebuild hooks + session-events (Phase 4B) + permission (Phase 6).`

**Startup gate behavior** (`index.ts:485-503`):
- `loadHooks` returns `HookLoadResult` with `registered: number` and `skipped: string[]`.
- If `hookResult.registered < MIN_EXPECTED_HOOKS` → throws.
- `try/catch` at `index.ts:485-503` logs at `error` level then re-throws.
- Re-throw propagates up to `start()` at `index.ts:461`; outer catch at `530-533` calls `process.exit(1)`.

**Verdict:** Hard-fail (process.exit(1)) on hook shortage. The `skipped` list is JSON-stringified in the thrown error so operators can diagnose. No drift between comment, constant, and map length.

---

## 3. Lifecycle Singleton

**Definition:** `export const lifecycle = new Lifecycle()` at `services/agent-claw/src/core/runtime.ts:22`. One instantiation in the entire codebase.

**Imports of this singleton:**

| File | Line | Usage |
|---|---|---|
| `services/agent-claw/src/index.ts:71` | `import { lifecycle }` | `loadHooks(lifecycle, ...)` |
| `services/agent-claw/src/routes/chat.ts:47` | import | passed to `runHarness` |
| `services/agent-claw/src/routes/deep-research.ts:31` | import | passed to `runHarness` |
| `services/agent-claw/src/routes/plan.ts:18` | import | passed to `runHarness` in `/api/chat/plan/approve` |
| `services/agent-claw/src/routes/sessions.ts:37` | import | used in chained-harness loop |
| `services/agent-claw/src/tools/builtins/dispatch_sub_agent.ts:15` | import | passed into sub-agent spawn |

**Sub-agent check:** `sub-agent.ts` does NOT call `new Lifecycle()`. The caller (`dispatch_sub_agent.ts:15`) passes the singleton in. Documented exception holds.

**Verdict:** Singleton is canonical. No duplicate instances.

---

## 4. Harness Call-Path Coverage

| Route | File:line | Imports singleton? | Calls runHarness? |
|---|---|---|---|
| `POST /api/chat` | `routes/chat.ts:753` | yes | yes |
| `POST /api/chat/plan/approve` | `routes/plan.ts:87-95` | yes | yes |
| `POST /api/sessions/:id/plan/run` | `routes/sessions.ts:185` → `runChainedHarness` → `_runChainedHarnessInner:576` | yes | yes |
| `POST /api/sessions/:id/resume` | `routes/sessions.ts:304` → same `_runChainedHarnessInner` | yes | yes |
| `POST /api/deep_research` | `routes/deep-research.ts` | yes | yes |

**Note:** `harness.ts:57-59` fills `ctx.lifecycle = lifecycle` if not already set, so even routes that omit lifecycle from their initial `ToolContext` (like `plan/approve` at `plan.ts:70-72`) get it threaded in before any hook reads `ctx.lifecycle`.

---

## 5. RLS Context Wrapping

Every `pool.query`/`client.query` in `services/agent-claw/src/routes/` and `src/security/` audited.

**Wrapped (correct):**
- `routes/chat.ts` — `loadSession`/`saveSession`/`createSession` delegate to `session-store.ts` (uses `withUserContext`); `writeFeedback:159-173` wraps `withUserContext`.
- `routes/sessions.ts` — `GET /api/sessions:121` uses `withUserContext`; `loadSession` delegates with user context.
- `routes/artifacts.ts:54-59` — `withUserContext`.
- `routes/feedback.ts:48` — `withUserContext`.
- `routes/optimizer.ts` — `withSystemContext` after admin gate at 27-38.
- `routes/learn.ts` — `withUserContext` throughout.
- `routes/skills.ts` — `requireAdmin` wraps `withUserContext`.
- `routes/documents.ts` — `withUserContext`.
- `routes/eval.ts` — `withSystemContext` (system data).

**System probes (RLS exempt — correct):**
- `index.ts readyz handler:370-397` — `pool.query("SELECT 1")` and catalog reads.
- `probeMcpTools` at `index.ts:421-422,441` — system catalog reads.

**Finding F-1 (Confidence 82) — `checkStaleFacts` is dead code in the hook path.**
`services/agent-claw/src/core/hooks/source-cache.ts:380-404`. Exported function uses naked `pool.query` on `ingestion_events` (cross-tenant aggregate count). Documented in YAML (`stale_check_phase: pre_turn`) and the file header as a pre-turn stale warning. However, `registerSourceCacheHook` at line 511-521 only registers `sourceCachePostToolHook` at `post_tool`; **no `pre_turn` registration** for `checkStaleFacts`. Feature silently absent. Secondary concern: if wired in future, the naked `pool.query` would need `withSystemContext` to pass RLS for `chemclaw_app`.

**Verdict:** No user-facing query is naked. Documented probes and the dead `checkStaleFacts` are the only naked `pool.query` calls.

---

## 6. `/api/internal/*` JWT Trust

**Route:** `POST /api/internal/sessions/:id/resume` at `services/agent-claw/src/routes/sessions.ts:338-417`.

**JWT verification trace:**
1. `sessions.ts:347` — reads `req.headers["authorization"]`.
2. `sessions.ts:350-358` — `verifyBearerHeader(authz, { requiredScope: "agent:resume" })`.
3. `sessions.ts:359` — `claimedUser = claims.user`.
4. `sessions.ts:376` — `tryIncrementAutoResumeCount(pool, claimedUser, sessionId)`.
5. `sessions.ts:398` — `runChainedHarness({ ..., user: claimedUser, ... })`.

**`x-user-entra-id`:** Not read in this handler. The public `/api/sessions/:id/resume` uses `getUser(req)` (which reads the header), but the internal route bypasses `getUser` entirely and uses JWT claims.

**Verdict:** Correct. JWT-only trust at `sessions.ts:350-359`, exactly as CLAUDE.md documents.

---

## 7. MCP Middleware Coverage

| Service | `create_app` used? | Direct `FastAPI()`? |
|---|---|---|
| `mcp_rdkit/main.py:25` | yes | no |
| `mcp_drfp/main.py:21` | yes | no |
| `mcp_doc_fetcher/main.py:49` | yes | no |
| `mcp_kg/main.py:17` | yes | no |
| `mcp_eln_local/main.py:45` | yes | no |
| `mcp_logs_sciy/main.py:29` | yes | no |

**`create_app` chain** (`common/app.py:136-241`):
- `mcp_auth_middleware` — verifies Bearer JWT via `verify_mcp_token`. Fail-closed in prod (`MCP_AUTH_REQUIRED=true`); dev-mode opt-in. `_require_or_skip()` is the single policy evaluator.
- `add_request_id` — stamps `x-request-id`.
- `ValueError → 400` exception handler.
- `/healthz` and `/readyz` exempted (lines 163-165).

**`mcp_logs_sciy` nuance:** imports `FastAPI` at line 23 only for typing; calls `create_app(...)` at line 29. Not a bypass.

**Verdict:** All 6 production MCP services use `create_app`. Auth middleware uniformly applied.

---

## 8. Hook Callback Shape Compliance

**Canonical shape** (`hook-output.ts:46-50`):
```typescript
type HookCallback<P = unknown> = (
  input: P,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;
```

| Hook | Signature | Signal accepted? | Compliant? |
|---|---|---|---|
| `redact-secrets` | `(payload, _toolUseID?, _options?)` | yes | YES |
| `budget-guard` | `(payload, _toolUseID?, _options?)` | yes | YES |
| `init-scratch` | `(payload, _toolUseID?, _options?)` | yes | YES |
| `foundation-citation-guard` | `(payload, _toolUseID?, _options?)` | yes | YES |
| `session-events` | `(_payload, _toolUseID?, _options?)` | yes | YES |
| `permission` | `(_payload, _toolUseID?, _options?)` | yes | YES |
| `apply-skills` | `(payload, _toolUseID?, _options?)` | yes | YES |
| `tag-maturity` | `async (payload) => tagMaturityHook(payload, pool)` at `tag-maturity.ts:138` | NO | shape mismatch |
| `compact-window` | `async (payload: PreCompactPayload) => {...}` at `compact-window.ts:51` | NO | shape mismatch |
| `source-cache` | `async (payload: PostToolPayload) => {...}` at `source-cache.ts:512` | NO | shape mismatch |

**Finding F-2 (Confidence 83) — Three hooks ignore AbortSignal.**

- `tag-maturity.ts:138` — closure ignores `toolUseID` and `signal`.
- `compact-window.ts:51` — single-param lambda; this hook makes a synchronous LLM call (`compact(messages, { llm })`) that cannot be cancelled if the 60s timer fires.
- `source-cache.ts:512` — single-param lambda; DB inserts inside cannot be aborted.

**Impact:** TypeScript's structural typing accepts shorter signatures, so dispatch works. The dispatcher's abort-race at `lifecycle.ts:193-212` unblocks after 60s, but the stalled operation continues in the background. Documented "best-effort abort" — but `compact-window` is the highest-risk case: under degraded LLM, zombie LLM calls can run for minutes per stalled invocation.

---

## 9. Decision Aggregation Order

**Aggregator:** `mostRestrictive` at `services/agent-claw/src/core/hook-output.ts:60-71`:

```typescript
const order: Record<PermissionDecision, number> = {
  deny: 4,
  defer: 3,
  ask: 2,
  allow: 1,
};
return !a || order[b] > order[a] ? b : a;
```

**Order:** `deny(4) > defer(3) > ask(2) > allow(1)` — matches documented `deny > defer > ask > allow`.

**Called from** `lifecycle.ts:239-243`:
```typescript
const next = mostRestrictive(decision, dec);
if (next !== decision) {
  decision = next;
  reason = hso?.permissionDecisionReason;
}
```

**Two `defer` returns:** `mostRestrictive("defer", "defer")` → returns `a`. Aggregate stays `defer`. Reason is preserved from the **first** hook (since `next !== decision` is false). Correct: first hook to land at a tier owns the reason.

**`undefined` first value:** `mostRestrictive(undefined, "allow")` → returns `b`. A fresh accumulation starts at "no opinion" and any decision wins until override. Correct.

**Verdict:** Aggregation is correct. Cite `hook-output.ts:60-71`, `lifecycle.ts:237-245`.

---

## 10. Hook Timeout Default

**Constant:** `DEFAULT_HOOK_TIMEOUT_MS = 60_000` at `services/agent-claw/src/core/lifecycle.ts:63`.

**Per-dispatch wiring** (`lifecycle.ts:164-167`):
```typescript
const ac = new AbortController();
const timer = setTimeout(
  () => ac.abort(new Error(`hook timeout: ${hook.name}`)),
  hook.timeout,
);
```

**Usage:** `Lifecycle.on(...)` at `lifecycle.ts:92`: `timeout: opts.timeout ?? DEFAULT_HOOK_TIMEOUT_MS`. Every hook without explicit `timeout` gets 60s.

**Verdict:** Correctly wired.

---

## Summary of Findings

### Critical
None.

### Important

**F-1 (Confidence 82)** — `checkStaleFacts` is dead code in the hook path (`source-cache.ts:380-404`). Exported, documented in YAML, but never registered. Stale-fact warning feature silently absent. If wired in future, naked `pool.query` would need `withSystemContext`.

**F-2 (Confidence 83)** — Three hooks ignore `AbortSignal` (`tag-maturity:138`, `compact-window:51`, `source-cache:512`). `compact-window` is highest-risk: synchronous LLM call cannot be cancelled if 60s timer fires; zombie background calls under degraded LLM.

**F-3 (Confidence 80)** — `plan/approve` route at `services/agent-claw/src/routes/plan.ts:68-72` constructs `ToolContext` without `lifecycle` field. Currently mitigated by `harness.ts:57-59` filling it from `HarnessOptions`. Latent footgun for future contributors who add lifecycle dispatch before the harness call.

### Items Confirmed Correct

- Singleton lifecycle: one `new Lifecycle()`, shared across all five harness call paths.
- `MIN_EXPECTED_HOOKS = 11` matches actual count; startup gate hard-fails (`process.exit(1)`).
- All user-facing DB queries wrapped in `withUserContext` or `withSystemContext`.
- `readyz` and mcp-probe naked `pool.query` calls are system probes.
- `/api/internal/sessions/:id/resume` reads user from JWT `claims.user`, never from header.
- All 6 MCP services use `create_app`; full auth chain inherited.
- Decision aggregation `deny > defer > ask > allow` correctly implemented.
- Hook timeout constant 60,000 ms correctly wired per-dispatch.

---

*End of Track F Boundary Audit — 2026-04-29*
