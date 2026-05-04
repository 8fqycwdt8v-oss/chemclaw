# agent-claw TypeScript Quality Audit — 2026-05-03

Scope: `services/agent-claw/src/` (~26.7k LOC, 184 .ts files). Read-only audit.
The merged-feature-branch state is already significantly cleaner than the
2026-04-29 baseline — `chat.ts` is down from 975 LOC to 593, `sessions.ts`
from 758 to 95, `runChainedHarness` lives in its own module, and the bulk
of the priority-1 split sketches in
`docs/review/2026-04-29-codebase-audit/01-ts-hotspots.md` have landed.

`tsc --noEmit` is clean. Only **3** untyped/`any` survivors remain across
the whole `src/` tree; **0** `console.*` calls; **1** `eslint-disable`;
ESLint runs `strict-type-checked` with `no-explicit-any: error`. The
remaining issues are mostly *parity*, *envelope hygiene*, and a small
catalogue of cross-route duplications that didn't get swept in the PR-6
split.

---

## Executive Summary (≤ 800 words)

| Severity | Finding | File:line | Fix sketch |
| --- | --- | --- | --- |
| **High** | Permission resolver is wired to `permissions: { permissionMode: "enforce" }` ONLY on the SSE streaming branch of `/api/chat`. Every other harness call path (non-streaming chat via `agent.run`, `runPlanModeStreaming`, `runChainedHarness` — feeding `/api/sessions/:id/plan/run`, `/api/sessions/:id/resume`, `/api/internal/sessions/:id/resume`, `/api/chat/plan/approve`, `/api/deep_research`, sub-agents) skips the resolver entirely. DB-backed `permission_policies` therefore don't fire on background, chained, or post-approval turns. | `src/routes/chat.ts:405` (only site); `src/routes/chat-non-streaming.ts:120`, `src/routes/plan.ts:104`, `src/routes/deep-research.ts:169,220`, `src/core/chained-harness.ts:206`, `src/core/sub-agent.ts:181` (missing) | Plumb `permissions: { permissionMode: "enforce" }` through `buildAgent`, `runChainedHarness`, `runPlanModeStreaming` deps, and into every `runHarness` call. Then collapse `routes/eval.ts:requireAdminEval` / `routes/optimizer.ts:requireAdmin` / `routes/skills.ts:requireAdmin` (see below) — once policies are uniformly enforced, the route-side admin checks belong in DB rows, not duplicated SQL. |
| **High** | Three duplicate ad-hoc `requireAdmin`s scoped on `user_project_access.role='admin'` co-exist with the canonical DB-backed `middleware/require-admin.ts:isAdmin` (which queries `admin_roles` via `current_user_is_admin()`). Two semantic models for "is this user an admin" run in parallel — `/api/admin/*` and `forged-tools` use `admin_roles`; `/api/eval`, `/api/optimizer`, `/api/skills/enable\|disable` use `user_project_access`. A user granted `global_admin` in the new table cannot configure skills via `/api/skills/enable`. | `src/routes/eval.ts:75-92`, `src/routes/optimizer.ts:23-56`, `src/routes/skills.ts:24-36`, `src/middleware/require-admin.ts:26-79` | Replace the three duplicates with `guardAdmin(pool, user, reply, "global_admin")` from `middleware/require-admin.ts`. Document the role tier each route requires. |
| **High** | The `error` SSE/HTTP envelope diverges across the codebase. The structured envelope in `src/errors/envelope.ts` (`toEnvelope`/`envelopeFor`) is consumed by **only one** call site (`src/bootstrap/auth.ts`). Every other 4xx/5xx still emits raw `{ error: "<code>", detail?: ... }`. The error-code catalogue in `src/errors/codes.ts` (`ERROR_CODES.AGENT_INTERNAL`, etc.) is similarly used only in `bootstrap/auth.ts` and `errors/envelope.ts`. A client cannot rely on `error.message` / `error.trace_id` / `error.request_id` outside the 401 path. | `src/errors/envelope.ts:70` (`toEnvelope` ts-prune-flagged unused); `src/routes/{chat-helpers,sessions-handlers,deep-research,documents,eval,feedback,learn,optimizer,skills,artifacts,forged-tools,chat-slash,chat-non-streaming,chat-streaming-error,chat-plan-mode}.ts` — every `reply.code(...).send({ error: ... })` site bypasses the envelope. | Replace every `reply.code(N).send({ error: code, detail })` with `reply.code(N).send(envelopeFor(ERROR_CODES.X, msg, { detail }))`. Wire the SSE `error` frame the same way (`writeEvent(reply, { type: "error", ...envelopeFor(...) })`) so SSE consumers also see `trace_id`/`request_id`. |
| **Medium** | Three near-identical `isAbortError` predicates. | `src/core/harness.ts:40` (`_isAbortError`), `src/routes/chat-helpers.ts:74` (`isAbortLikeError`), `src/routes/deep-research.ts:271` (`_isAbortLikeError`), `src/observability/with-retry.ts:60` (`isAbortError`, also checks `code === "ABORT_ERR"`) | Promote a single `isAbortError(err)` into `src/observability/abort.ts` (or `src/core/abort.ts`) — let everyone import it. |
| **Medium** | Paperclip reserve/release lifecycle still partially duplicated. The reserve helper extracted into `routes/chat-paperclip.ts` is great, but the release block (read budget summary → `paperclipHandle.release(totalTokens, actualUsd)` → log on failure) is still copy-pasted across `routes/chat.ts:530-538`, `routes/chat-non-streaming.ts:80-88`, `core/chained-harness.ts:267-276`, `core/chained-harness.ts:296-302`. | as cited | Add a `withPaperclipReservation(opts, fn)` in `core/paperclip-client.ts` that handles reserve→fn→release-on-success→release-on-error. The two routes + `runChainedHarness` collapse to a single try-block call. |
| **Medium** | Magic numbers `estTokens: 12_000` and `estUsd: 0.05` for the per-turn Paperclip reservation are duplicated and not derived from config. A drift between the chat-route default and the chained-harness default would silently change daily-cap behaviour for chained flows. | `src/routes/chat-paperclip.ts:43-44`, `src/core/chained-harness.ts:150-151` | Export `PAPERCLIP_RESERVATION_DEFAULTS = { estTokens: 12_000, estUsd: 0.05 }` from `core/paperclip-client.ts`; both call sites import. Better: feed from `Config`. |
| **Medium** | Two `Continue …` prompts hand-written — one for resume, one for plan continuation. Drift between them changes the model's behaviour on chained turns silently. | `src/routes/sessions-handlers.ts:36-38` ("Continue with the next step on your todo list…"), `src/core/chained-harness.ts:282-284` ("Continue from the last step. Stop when the plan is complete.") | Hoist as named constants (`RESUME_CONTINUE_PROMPT`, `CHAIN_CONTINUE_PROMPT`) in `core/chained-harness.ts` — the rationale comment for keeping them distinct can move with them. |
| **Medium** | `routes/sessions.ts:32-33` re-exports `runChainedHarness`, `ChainedHarnessOptions`, `ChainedHarnessResult` "for tests + bootstrap". `ts-prune` flags them unused — production uses the real path `core/chained-harness.ts`. The integration test (`tests/integration/chained-execution.test.ts`) should import from `core/chained-harness.js` directly. | `src/routes/sessions.ts:32-33` | Drop the re-exports; update the integration test's import. |
| **Medium** | `src/streaming/sse.ts:34-49` exports the canonical `StreamEvent` discriminated union. `routes/chat.ts:61` re-exports it for back-compat. `ts-prune` flags this re-export unused — every test importing `StreamEvent` already pulls from `streaming/sse.js` directly. | `src/routes/chat.ts:61` | Delete the re-export. |
| **Medium** | `MIN_EXPECTED_HOOKS = 11` (`src/bootstrap/start.ts:29`) is a magic constant in start.ts, not in the loader. CLAUDE.md (Harness Primitives section) instructs every contributor to bump it when adding a hook, but the constant lives next to the assertion, not next to `BUILTIN_REGISTRARS` where the new hook would be added. The next contributor will miss the bump. | `src/bootstrap/start.ts:29`, `src/core/hook-loader.ts:94+` | Move `MIN_EXPECTED_HOOKS` into `core/hook-loader.ts` next to `BUILTIN_REGISTRARS`; export it; have `start.ts` import it. The pull request that adds a hook then necessarily touches both lines in the same diff. |
| **Medium** | `mcp/postJson.ts` `postJson` (lines 115-152) and `getJson` (lines 161-196) duplicate ~30 LOC of fetch / signal-combination / response-parsing. `getJson` is also dead — `ts-prune` flags it; the only importer is `tests/unit/postJson-correlation.test.ts`. | `src/mcp/postJson.ts:115-196` | Either delete `getJson` or unify both behind a private `_doRequest(method, body?)` and keep `getJson` as a thin wrapper. |
| **Medium** | `prompts/shadow-evaluator.ts:112` reads `process.env.AGENT_SHADOW_SAMPLE` directly with its own `parseFloat`, even though `config.ts:182` already parses + validates the same key as a typed `Config.AGENT_SHADOW_SAMPLE`. CLAUDE.md mandates "every `process.env.X` should be: read once at boot from a config module". | `src/prompts/shadow-evaluator.ts:112`, `src/config.ts:182` | Pass `cfg.AGENT_SHADOW_SAMPLE` into the `ShadowEvaluator` constructor; remove the `process.env` read. |
| **Medium** | `MCP_HEALTH_PROBE_INTERVAL_MS = 60_000` is hardcoded in `bootstrap/probes.ts:14` and the probe loop's first invocation is delayed by that full interval (`startMcpProbeLoop` schedules the first call after `setTimeout(..., MCP_HEALTH_PROBE_INTERVAL_MS)`). Right after startup, `/readyz` returns `no_healthy_mcp_tools` for up to 60 seconds — a flapping k8s readiness probe in production. | `src/bootstrap/probes.ts:14, 100-104` | Run `await probeMcpTools(app, pool)` once before the interval kicks in; or use `setTimeout(..., 0)` for the first iteration. Promote the interval to a `Config` field. (Already flagged in the 2026-04-29 audit; carried through.) |
| **Medium** | Stale comment in `src/core/types.ts:284-287`: "the resolver in core/permissions/resolver.ts only fires when a route passes a `permissions` option to runHarness, which no production route does today." `chat.ts:405` does pass it. The comment misleads contributors into believing the permission system is dormant. | `src/core/types.ts:284-287` | Replace with the actual current state: "fires for the SSE streaming branch of `/api/chat`; other call paths still bypass." (And then make the High-severity finding above true so the comment can be deleted.) |
| **Medium** | Dead/unwired safety helpers. `src/security/workspace-boundary.ts:48` (`assertWithinWorkspace`) — full implementation, has unit tests, no production caller. `src/observability/with-retry.ts:70` (`withRetry`) — same. `src/core/sandbox.ts:151` (`buildSandboxClient`) — only mounted via tests; no factory wiring in `bootstrap/dependencies.ts`. | as cited | Either wire to a known consumer (the `forge_tool` family for `withRetry`, any path-touching tool for `assertWithinWorkspace`, the registry's sandbox slot for `buildSandboxClient`) or delete with an ADR note. |
| **Low** | `process.env` reads still scattered at 24 sites. The 14 outside `config.ts` cluster around bootstrap (security/JWT keys, OTel, sandbox, observability). All are read once — no per-request readers — but bypass the typed `Config` schema. | (full list in body, §"process.env audit") | Each → `Config` field. Lowest-priority backlog. |
| **Low** | `tsconfig.json` lacks `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`. `noUncheckedIndexedAccess` is on; the others would surface real bugs in scratchpad / config-registry code paths that read by string key. Tests are excluded from the typecheck (`exclude: ["…", "tests"]`); the eslint config has its own `tsconfig.eslint.json` that includes them, so the gap is real but mitigated. | `services/agent-claw/tsconfig.json:9-12, 21` | Flip the three flags on; fix surfaced sites. Include `tests/` in the typecheck (run `tsc --noEmit -p tsconfig.eslint.json` in CI). |
| **Low** | `feedback_events` insert is duplicated. `routes/chat-helpers.ts:recordFeedback` (used by `chat-slash.ts`) writes 4 columns; `routes/feedback.ts:insertFeedback` writes 6 columns including `prompt_name` / `prompt_version`. The /feedback slash thus loses prompt-scope linkage that the API endpoint preserves — silent feature divergence. | `src/routes/chat-helpers.ts:114-128`, `src/routes/feedback.ts:40-64` | Single `insertFeedbackEvent(pool, user, payload)` helper in `db/queries/feedback.ts`; both callers use it. |
| **Low** | `routes/sessions.ts:46` declares `paperclip?: PaperclipClient` optional in `SessionsRouteDeps`, but `bootstrap/routes.ts:85` always passes it — the type optionality is never consumed. Same for `config?`/`llm?`/`registry?` (the route-level handlers throw 500 when missing). The optional-ness was an artefact of the original split and is now misleading. | `src/routes/sessions.ts:35-48` | Make `config`/`llm`/`registry`/`paperclip` required in `SessionsRouteDeps`. |
| **Low** | Test parity: 14 routes have no test file that imports from them by name. Some are wrapper-shaped (`chat-helpers`, `chat-paperclip`) and covered transitively, but `routes/eval.ts` (admin-gated, payload-mutating) has no dedicated unit test, nor does `routes/optimizer.ts`, `routes/forged-tools.ts` (see below), `routes/sessions-handlers.ts`. | (full list in body, §"Test parity") | Add unit tests for the admin-gated routes at minimum. |
| **Low** | Hooks without dedicated unit tests: `apply-skills`, `init-scratch`, `permission`, `session-events`. They are exercised indirectly via `hook-loader-coverage.test.ts` and `extended-hooks-fire.test.ts`, but their decision branches (e.g. `permission` no-op vs deny aggregation) aren't isolated. | `src/core/hooks/*.ts` vs `tests/unit/hooks-*.test.ts` | One small test per hook validating its individual decision matrix. |
| **Low** | `bootstrap/start.ts:registerProcessHandlers` — graceful shutdown calls `app.close()` and `pool.end()` with no timeout, no force-exit. A stuck SSE connection holds Fastify's close until socket TTL. K8s `terminationGracePeriodSeconds` will SIGKILL the process; user state in flight is lost. | `src/bootstrap/start.ts:110-122` | Wrap `app.close()` in `Promise.race([app.close(), timeout])`; force-end open SSE connections via `app.server.closeAllConnections()` (Node 18.2+). |
| **Low** | `bootstrap/dependencies.ts:175` keeps the `asTool = (t: unknown) => t as Tool` workaround flagged in the 2026-04-29 audit. The registry's `registerBuiltin(name, factory)` signature still doesn't accept `Tool<unknown, unknown>` directly, so every builtin registration carries the cast. | `src/bootstrap/dependencies.ts:175` (1 cast); 60+ registration sites use `asTool(...)` | `ToolRegistry.registerBuiltin(name: string, factory: () => Tool)` — `Tool` is already structurally `Tool<unknown,unknown>` in `tools/tool.ts`. Drop the helper. |
| **Low** | Logger doc/code mismatch. CLAUDE.md (logging section) says the TS logger "redacts `authorization` / `cookie` / `err.message` / `err.stack` / `detail` automatically." `src/observability/logger.ts:62-73` says "We deliberately do NOT redact `err.message` / `err.stack`." The code is correct (a triaging operator needs them); the docs are wrong. | `src/observability/logger.ts:62-73` vs CLAUDE.md `## Logging` | Update CLAUDE.md to match the code. |

---

## Hotspots Map

### Files > 400 LOC

| File | LOC | Reason |
|---|---|---|
| `src/routes/chat.ts` | 593 | Down from 975. Now reasonable — most logic is delegated to the 5 sibling modules; the size is mostly comments + the long try/finally end-of-turn dance. The end-of-turn block (lines 422-556) could move into `routes/chat-end-of-turn.ts` per the 2026-04-29 sketch but the gain is marginal — the captured-variable surface is large and the helper signature would have ~12 parameters. **Hold.** |
| `src/core/hooks/source-cache.ts` | 507 | Legit complexity — five distinct extractors (ELN entry, canonical reaction, sample, instrument dataset) plus a transactional batch insert. Each extractor is a pure function. **Cohesive — keep.** |
| `src/tools/registry.ts` | 492 | Hosts the JSON-Schema → Zod compiler, the `loadFromDb` hydrator (3 source kinds: builtin/mcp/forged), and the weak-from-strong tier sort. The compiler (lines 38-99) could move to `tools/zod-from-jsonschema.ts` to make the registry a focused class — modest split candidate. |
| `src/tools/builtins/forge_tool.ts` | 470 | Test-suite generation, validation rounds, sandbox execution wiring. Cohesive within the forge_tool concern but ripe for splitting per concern (validation pass / DB write / SHA stamp). |
| `src/core/session-store.ts` | 444 | Session row CRUD + Todo CRUD + atomic auto_resume increment. Five exported async functions, each with clear responsibility. **Keep.** |
| `src/core/types.ts` | 431 | Cross-module type definitions. **Keep — the central type registry is by-design large.** |
| `src/core/skills.ts` | 418 | Loader scans filesystem + DB skill rows + activation gates. Cohesive. **Keep.** |
| `src/routes/sessions-handlers.ts` | 410 | Five handler functions (`handleGetSession`, `handleListSessions`, `handlePlanRun`, `handleResume`, `handleInternalResume`) plus shared `executeResume`. Cohesive post-split. **Keep.** |
| `src/core/step.ts` | 396 | `_runOneTool` (165 LOC, single tool path) + `stepOnce` (orchestrator). Already factored. **Keep.** |
| `src/core/chained-harness.ts` | 384 | Loop body + Paperclip lifecycle + plan-progress walker + error classifier + session_end dispatch. Cohesive — but the inner try/catch/iteration loop (lines 130-327) is 200 LOC and could benefit from a `_runOneIteration(state, opts)` extract per the 2026-04-29 sketch. |
| `src/core/harness.ts` | 323 | runHarness loop + buildAgent. **Keep.** |
| `src/routes/deep-research.ts` | 317 | Owns its own bounds, system-prompt assembly, and harness call. Notably duplicates patterns covered by `chat-helpers.ts` (`enforceBounds`) and `chat-setup.ts` (`buildSystemPromptForTurn`). See §"Refactor Catalog DR-1". |

### Files with > 5 `any` casts in src/ body

**None.** ESLint's `no-explicit-any: error` plus `no-unsafe-*` family is locked in. The total count of `any` in `src/` is **3**, all of which are non-load-bearing comments or column-name strings:

```
src/tools/registry.ts:460     (row.schema_json as unknown as Record<string, unknown>).properties ?? {}
src/core/step.ts:353          comment "any state-mutating tool…"
src/security/workspace-boundary.ts:12  comment "any tool that reads…"
```

Only `tools/registry.ts:460` is a real cast — and it's well-scoped: hydrating a JSON schema column from the DB.

### Files with > 3 disabled ESLint comments

**None.** Total `eslint-disable` count in `src/` is **1** (`src/core/hook-loader.ts:269`, a `no-unsafe-assignment` for the dynamic `js-yaml` parse output). The strict-type-checked baseline is held without escapes.

---

## Refactor Catalog (Full Appendix)

### PARITY-1 — `permissions: { permissionMode: "enforce" }` only on one call path
- **Severity:** High
- **File:line — present:** `src/routes/chat.ts:387-406`
- **File:line — missing:** `src/routes/chat-non-streaming.ts:120` (calls `agent.run`); `src/core/harness.ts:300-322` (`buildAgent.run` doesn't accept `permissions`); `src/routes/plan.ts:104-112`; `src/routes/deep-research.ts:169-177` and `src/routes/deep-research.ts:220-229`; `src/core/chained-harness.ts:206-214`; `src/core/sub-agent.ts:181-188`.
- **Before — `chat.ts:405`:**
  ```ts
  await runHarness({
    messages, tools, llm, budget, lifecycle, ctx,
    streamSink: sink, sessionId: sessionId ?? undefined, signal,
    permissions: { permissionMode: "enforce" },
  });
  ```
- **Before — `chained-harness.ts:206-214`:**
  ```ts
  const r = await runHarness({
    messages: currentMessages, tools, llm, budget, lifecycle, ctx,
    signal: opts.signal,
    // no permissions
  });
  ```
- **After — pattern:** introduce a per-route `permissions` configuration option. Pass `{ permissionMode: "enforce" }` from every call path that runs a user's tool calls (chat, plan/approve, sessions plan/run + resume, deep-research). Sub-agents are policy-internal and may keep `default` mode if desired (open question — the parent's permissions context could be inherited via `parentCtx`).
- **Why better:** the project's own design doc (`CLAUDE.md` § Permission policies) says "Routes that run user-driven tool calls MUST pass `{ permissions: { permissionMode: "enforce" } }` to runHarness so the policies fire." Today only one route does. Background/chained/post-approval turns silently bypass `permission_policies` rows.
- **Effort:** Medium. Plumbing through `buildAgent`, `ChainedHarnessOptions`, the deep-research handler, and `routes/plan.ts:104`.
- **Risk:** Low for chat/dr/plan-mode (resolver is permissive when no policy matches; `allow when no policy matches` is the documented behaviour for `enforce` mode at `core/permissions/resolver.ts:126`). Medium for chained execution if a deny rule trips mid-chain — needs an end-of-chain grace path, but the existing `_classifyChainError` block already handles arbitrary errors gracefully.

### ADMIN-1 — Three duplicate ad-hoc admin checks vs the canonical helper
- **Severity:** High
- **File:line:** `src/routes/eval.ts:75-92`, `src/routes/optimizer.ts:23-56`, `src/routes/skills.ts:24-36`. Canonical in `src/middleware/require-admin.ts:26-79`.
- **Before — `routes/optimizer.ts:23-38`:**
  ```ts
  async function requireAdmin(pool: Pool, user: string): Promise<boolean> {
    return await withUserContext(pool, user, async (client) => {
      const r = await client.query<{ has_admin: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM user_project_access
            WHERE user_entra_id = $1 AND role = 'admin'
         ) AS has_admin`,
        [user],
      );
      return r.rows[0]?.has_admin === true;
    });
  }
  ```
- **Before — `routes/eval.ts:75-92`:** identical SQL, but using `withSystemContext` instead of `withUserContext`.
- **After — pattern:** `await guardAdmin(pool, user, reply, "global_admin")` everywhere, deleting all three local functions. Decide explicitly per route whether the legacy `user_project_access role='admin'` semantics or the new `admin_roles` semantics are correct; CLAUDE.md says the new table is canonical (`admin_roles ... replaces the AGENT_ADMIN_USERS env-var check`).
- **Why better:** today an admin granted via the new `admin_roles` table cannot use `/api/skills/enable` (it checks `user_project_access`). Two semantic models are running in parallel.
- **Effort:** Small (3 routes × ~15 LOC each).
- **Risk:** Functional change — operators relying on the project-admin shortcut for `/api/eval` etc. will need a migration. Add a row in `admin_roles` for each existing project admin before flipping. ADR-required.

### ENVELOPE-1 — Error envelope fragmentation
- **Severity:** High
- **File:line:** `src/errors/envelope.ts:70` (`toEnvelope`, ts-prune-flagged unused). 30+ raw `reply.code(N).send({ error: "X" })` sites listed in §"Executive Summary".
- **Before — `routes/sessions-handlers.ts:64-68`:**
  ```ts
  return await reply.code(400).send({ error: "invalid_input", detail: "session id must be a UUID" });
  ...
  return await reply.code(404).send({ error: "not_found" });
  ```
- **After — pattern:**
  ```ts
  return await reply.code(400).send(envelopeFor(
    ERROR_CODES.AGENT_INVALID_INPUT, "session id must be a UUID"));
  ```
- **Why better:** uniform `{ error, message, request_id, trace_id, hint?, detail? }` shape lets clients correlate every failure to a Langfuse trace + Loki log. Today only the 401 path provides this; the rest are opaque.
- **Effort:** Medium (mechanical sweep across ~12 route files).
- **Risk:** Low — the envelope is additive (`error` stays the legacy short string), so existing CLI / clients that read `error` keep working.
- **SSE caveat:** the SSE `error` frame in `streaming/sse.ts:49` already supports `trace_id`/`request_id` siblings, but only `chat-streaming-error.ts` populates them. `chat-plan-mode.ts:124`, `chat-slash.ts:82` write the bare frame. Same fix.

### DEDUP-1 — Three `isAbortError` predicates
- **Severity:** Medium
- **File:line:** `src/core/harness.ts:40-47`, `src/routes/chat-helpers.ts:74-81`, `src/routes/deep-research.ts:271-278`, `src/observability/with-retry.ts:60-64`.
- **Variation:** `with-retry.ts:isAbortError` ALSO checks `e.code === "ABORT_ERR"`; the others only check `e.name === "AbortError"`. Subtle inconsistency: a `ABORT_ERR`-typed cancellation in `harness.ts` would NOT be classified as a clean cancel but would propagate as a generic error. The Node fetch built-in *can* throw with `code: "ABORT_ERR"` on connection-time cancellations.
- **After — pattern:** single `isAbortError(err)` in `core/abort.ts` that checks both `name === "AbortError"` AND `code === "ABORT_ERR"`. Every existing call site imports it.
- **Why better:** kills three near-duplicates and fixes the latent name/code drift.
- **Effort:** Small.
- **Risk:** Low.

### DEDUP-2 — Paperclip release block × 4
- **Severity:** Medium
- **File:line:** `src/routes/chat.ts:530-539`, `src/routes/chat-non-streaming.ts:80-88`, `src/core/chained-harness.ts:267-276`, `src/core/chained-harness.ts:296-302` (catch-side).
- **Common shape:**
  ```ts
  if (paperclipHandle) {
    try {
      const totalTokens = usage.promptTokens + usage.completionTokens;
      const actualUsd = totalTokens * USD_PER_TOKEN_ESTIMATE;
      await paperclipHandle.release(totalTokens, actualUsd);
    } catch (relErr) {
      log.warn({ err: relErr }, "paperclip /release failed (non-fatal)");
    }
  }
  ```
- **After — pattern:** add to `core/paperclip-client.ts`:
  ```ts
  export async function withPaperclipReservation<T>(
    client: PaperclipClient | undefined,
    args: ReserveArgs,
    fn: (handle: ReservationHandle | null) => Promise<{ result: T; usage: TokenUsage }>,
    log: { warn: (...a: unknown[]) => void },
  ): Promise<T> { ... }
  ```
  Or, more conservative: a `releasePaperclipQuietly(handle, usage, log)` helper used by all four sites.
- **Why better:** four call sites collapse to one. A change to USD-per-token math (or a new field on the release shape) edits one place.
- **Effort:** Small.
- **Risk:** Low.

### DEDUP-3 — Two continue-prompt strings
- **Severity:** Medium
- **File:line:** `src/routes/sessions-handlers.ts:36-38`, `src/core/chained-harness.ts:282-284`.
- **After:** export `RESUME_CONTINUE_PROMPT` + `CHAIN_CONTINUE_PROMPT` from `core/chained-harness.ts`. Each site imports.
- **Risk:** Low; the two prompts are deliberately different ("with the next step on your todo list" vs "from the last step"). Keep them distinct, just hoist the strings.

### DEDUP-4 — Magic Paperclip reservation defaults
- **Severity:** Medium
- **File:line:** `src/routes/chat-paperclip.ts:43-44`, `src/core/chained-harness.ts:150-151`.
- **After:**
  ```ts
  // core/paperclip-client.ts
  export const PAPERCLIP_PER_TURN_RESERVE = {
    estTokens: 12_000,
    estUsd: 0.05,
  } as const;
  ```
- **Risk:** Low.

### DEDUP-5 — `feedback_events` insert paths
- **Severity:** Low
- **File:line:** `src/routes/chat-helpers.ts:114-128` (4 columns), `src/routes/feedback.ts:40-64` (6 columns: `prompt_name`, `prompt_version`).
- **Effect today:** `/feedback` slash records lose prompt linkage that the `/api/feedback` POST preserves. GEPA can't scope slash-feedback to a prompt version.
- **After:** single helper `insertFeedbackEvent(pool, user, { signal, reason, traceId, promptName?, promptVersion? })` in `db/queries/feedback.ts`. Both routes call it.
- **Risk:** Low.

### DEDUP-6 — `routes/sessions.ts` re-exports of chained-harness
- **Severity:** Medium
- **File:line:** `src/routes/sessions.ts:32-33`.
- **After:** delete the re-exports; the integration test (`tests/integration/chained-execution.test.ts`) imports directly from `../../src/core/chained-harness.js`.
- **Risk:** Low — the test is the only consumer per ts-prune.

### DEDUP-7 — `StreamEvent` re-export
- **Severity:** Low
- **File:line:** `src/routes/chat.ts:61`.
- **After:** delete; tests already import from `streaming/sse.js`.

### DR-1 — Deep research duplicates chat-helpers + chat-setup
- **Severity:** Medium
- **File:line:** `src/routes/deep-research.ts:43-94` (own request schema, bounds, system-prompt assembly).
- **Before:** custom `DrMessageSchema`, `DrRequestSchema`, `enforceBounds`, system-prompt loader. ~50 LOC of near-duplicate pre-harness setup.
- **After — pattern:** reuse `ChatRequestSchema`/`enforceBounds` (drop `agent_trace_id` if not used, accept `session_id` for free); reuse `buildSystemPromptForTurn(promptRegistry, undefined, false, log)` and append the DR suffix afterwards. The DR suffix becomes a one-line wrapper.
- **Why better:** the DR route diverged from chat in subtle ways (it lacks Paperclip reservation, lacks session persistence, lacks the permission-mode "enforce" flag). Most are intentional — DR is single-turn — but the bounds + prompt-loading code is identical and worth consolidating.
- **Effort:** Small.
- **Risk:** Low. The DR `messages` schema is the same shape as chat's; switching forwards-compatible.

### TYPES-1 — `runHarness` options surface
- **Severity:** Low (cleanup; not a bug)
- **File:line:** `src/core/harness.ts:55-67` and `300-322`.
- **Observation:** `buildAgent.run({...})` doesn't accept `permissions` (its options shape is `AgentCallOptions = { messages, ctx, signal? }`). The non-streaming chat path calls through `agent.run` and therefore CAN'T pass `permissions` even after PARITY-1 plumbing. Fix: extend `AgentCallOptions` with `permissions?: PermissionOptions`.
- **Effort:** Trivial.

### TYPES-2 — `routes/sessions.ts:SessionsRouteDeps` optional fields
- **Severity:** Low
- **File:line:** `src/routes/sessions.ts:35-48`.
- **After:** make `config`, `llm`, `registry`, `paperclip` required (or split into `ReadOnlySessionsDeps` / `HarnessSessionsDeps`). Deletes the `if (!deps.config || !deps.llm || !deps.registry) return 500 harness_deps_missing` checks at `sessions-handlers.ts:150, 323, 367` (3 sites).
- **Risk:** Low — `bootstrap/routes.ts:75-86` already passes all four.

### TYPES-3 — `bootstrap/dependencies.ts:asTool` cast
- **Severity:** Low
- **File:line:** `src/bootstrap/dependencies.ts:175`.
- **Cause:** `ToolRegistry.registerBuiltin(name, factory: () => Tool)` — `Tool` is `Tool<unknown, unknown>` per `tools/tool.ts`, but builtins return `Tool<TIn, TOut>` for specific schemas. The cast widens.
- **After:** Either accept `Tool<unknown, unknown>` directly (covariance check) OR define `registerBuiltin<T extends Tool<unknown,unknown>>(name: string, factory: () => T)`. Either kills the helper.
- **Risk:** Low.

### CONFIG-1 — `process.env` audit
- **Severity:** Low (cleanup)
- **File:line:** 14 sites outside `src/config.ts`. Already listed in §"Executive Summary"; full set:
  - `src/middleware/require-admin.ts:48` — `AGENT_ADMIN_USERS` (bootstrap fallback, documented in CLAUDE.md as intentional)
  - `src/tools/builtins/induce_forged_tool_from_trace.ts:42-44` — Langfuse host + keys
  - `src/core/sandbox.ts:51-62` — Sandbox CPU/MEM/NET caps
  - `src/security/mcp-tokens.ts:78, 145`, `src/security/mcp-token-cache.ts:76` — `MCP_AUTH_SIGNING_KEY` (fine; bootstrap)
  - `src/config/flags.ts:112` — feature-flag env-var fallback (intentional per CLAUDE.md)
  - `src/observability/user-hash.ts:40-45` — `LOG_USER_SALT` + `CHEMCLAW_DEV_MODE` (intentional)
  - `src/observability/otel.ts:50-67` — OTel exporter URL + Langfuse keys (one-time at boot)
  - `src/prompts/shadow-evaluator.ts:112` — `AGENT_SHADOW_SAMPLE` ← **drop, already in `Config`**
  - `src/core/hook-loader.ts:316,335` — hook YAML conditional env_var check (per-hook gate; intentional)
  - `src/db/with-user-context.ts:31` — `DB_SLOW_TXN_MS` (cheap heuristic; promote to Config for parity)
  - `src/observability/logger.ts:78` — `AGENT_LOG_LEVEL` (one-time at boot)
- **Action:** Promote `AGENT_SHADOW_SAMPLE`, `DB_SLOW_TXN_MS`, sandbox caps into `Config`. The rest are bootstrap-only or documented escape hatches.

### CONFIG-2 — `MIN_EXPECTED_HOOKS` lives in start.ts
- **Severity:** Medium
- **File:line:** `src/bootstrap/start.ts:29`.
- **After:** move to `core/hook-loader.ts` next to `BUILTIN_REGISTRARS`; export; `start.ts` imports.
- **Why better:** the next contributor adding a hook touches `BUILTIN_REGISTRARS` and the constant in the same file.

### TEST-1 — Route + hook test parity gaps
- **Severity:** Low
- **Routes without an importing test:** `chat-compact`, `chat-helpers`, `chat-non-streaming`, `chat-paperclip`, `chat-setup`, `chat-shadow-eval`, `chat-slash`, `documents`, `eval-parser`, `eval`, `forged-tools`, `healthz`, `optimizer`, `sessions-handlers`. (Some are wrapper-shaped; the tests cover them transitively via the parent chat / sessions tests. The admin-gated `eval`, `optimizer`, `forged-tools` routes carry the most testability risk.)
- **Hooks without dedicated tests:** `apply-skills`, `init-scratch`, `permission`, `session-events`. Each has a small decision matrix; covered indirectly via `hook-loader-coverage.test.ts` and `extended-hooks-fire.test.ts`.

### COMMENT-1 — Stale doc-strings
- **Severity:** Low
- **File:line:** `src/core/types.ts:284-287` (claims no production route passes permissions); `src/core/permissions/resolver.ts:5-8` (same claim). Both contradicted by `chat.ts:405`.
- **File:line:** `src/observability/logger.ts:62-73` vs CLAUDE.md `## Logging`. Code says "DO NOT redact err.message"; CLAUDE.md says "automatically redacts err.message".
- **Fix:** sync.

### DEAD-1 — Genuinely unused exports
- **Severity:** Low
- **Sites:** (from `npx ts-prune`, after subtracting test-only `__resetForTests` helpers)
  - `src/errors/envelope.ts:70` — `toEnvelope` (only `envelopeFor` is used; or wire it for the Fastify global error handler's path)
  - `src/observability/with-retry.ts:70` — `withRetry`
  - `src/security/workspace-boundary.ts:48` — `assertWithinWorkspace`
  - `src/mcp/postJson.ts:161` — `getJson`
  - `src/core/sandbox.ts:151` — `buildSandboxClient`
  - `src/core/slash.ts:126` — `parseForgedArgs`
  - `src/core/sub-agent.ts:66` — `Citation`
  - `src/core/confidence.ts:79,118,164` — `crossModelAgreement`, `extractFactIds`, `jaccardSimilarity`
  - `src/core/plan-mode.ts:99,107` — `PlanStepEvent`, `PlanReadyEvent`
  - `src/db/qm-cache.ts:89,124,185` — `computeQmCacheKey`, `lookupQmCache`, `invalidateQmCache`
  - `src/core/compactor.ts:80` — `shouldCompact`
- **Action:** triage in two waves. (a) Wire the safety-shaped ones (workspace-boundary, with-retry, sandbox factory) to a real consumer or delete with an ADR explaining the deferred decision. (b) Delete the orphaned plan-mode / sub-agent / confidence helpers; tests can be deleted alongside.

### CONNECTION-1 — Pool sizing visible only via env
- **Severity:** Low (informational)
- **File:line:** `src/db/pool.ts:22-34`. `max=POSTGRES_POOL_SIZE` (default 20), `idleTimeoutMillis=30_000` hardcoded, `connectionTimeoutMillis` from config, `statement_timeout` from config. Single shared pool; correctly created once in `bootstrap/dependencies.ts:121`.
- **Observation:** `idleTimeoutMillis` is the only knob not in `Config`. Promote for parity.

### SHUTDOWN-1 — No drain timeout
- **Severity:** Low
- **File:line:** `src/bootstrap/start.ts:110-122`.
- **Risk:** a stuck SSE client holds Fastify's close indefinitely. K8s SIGKILLs after `terminationGracePeriodSeconds`.
- **Fix:** wrap `app.close()` in `Promise.race([app.close(), new Promise(r => setTimeout(r, 30_000))])` then `app.server.closeAllConnections()` (Node 18.2+) before `pool.end()`.

### TSCONFIG-1 — Strictness gaps
- **Severity:** Low
- **File:line:** `services/agent-claw/tsconfig.json`.
- **Missing:** `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`. `tests/` excluded from typecheck.
- **Effect:** scratchpad / config-registry call sites that read by string key skip stricter type narrowing; optional properties can be assigned `undefined` explicitly without surfacing.
- **Action:** flip flags; fix surfaced sites.

---

## Cross-Reference: Prior Audit (`docs/review/2026-04-29-codebase-audit/01-ts-hotspots.md`)

| 2026-04-29 finding | 2026-05-03 status |
|---|---|
| `chat.ts` 975 LOC, 8 concerns interleaved | **Resolved** — split into 9 sibling modules under `routes/chat-*.ts`. `chat.ts` now 593 LOC and reads top-to-bottom. |
| `sessions.ts` 758 LOC, runChainedHarness inside | **Resolved** — `routes/sessions.ts` is 95 LOC of wiring; handlers in `sessions-handlers.ts`; `runChainedHarness` in `core/chained-harness.ts`. |
| `index.ts` 565 LOC, 8 concerns | **Resolved** — entrypoint is 53 LOC; `bootstrap/{server,dependencies,auth,probes,routes,start}.ts` carry the work. |
| `sandbox.ts` 6 explicit `any` casts | **Largely resolved** — only `mod as E2BModuleShape` remains (`core/sandbox.ts:110`); the explicit `any`s are gone. |
| `step.ts` 5 `any` casts (mostly `as { todos: ... }`) | **Resolved/refined** — the manage_todos cast at `step.ts:238-243` survives but is well-typed via `as { todos: TodoSnapshot[] }`. Acceptable shape-narrowing. |
| Four-fold static-text-completion send pattern | **Resolved** — `routes/chat-slash.ts:99-112` has a single `sendShortText` helper. |
| Paperclip reserve-side duplication | **Partially resolved** — reserve helper in `routes/chat-paperclip.ts`. **Release-side still duplicated 4× (DEDUP-2).** |
| Resume-handler post-increment 39-line duplicate | **Resolved** — `routes/sessions-handlers.ts:executeResume` shared. |
| `RESUME_CONTINUE_PROMPT` magic strings | **Partially** — moved into `sessions-handlers.ts:36` as a const, but the chained-harness one at `chained-harness.ts:283` is still inline. |
| Plan-mode body divergence (DB vs in-memory) | **Resolved** — `chat-plan-mode.ts:97-103` always persists when sessionId exists. |
| `index.ts:174 asTool = ... as ToolBuiltin` cast | **Carried** — same cast now lives at `bootstrap/dependencies.ts:175` (TYPES-3). |
| `getUser as (req: FastifyRequest) => string` retyping × 8 | **Resolved** — `bootstrap/auth.ts:setupAuthAndErrorHandler` typed cleanly; routes now receive a typed `getUser`. |
| `MIN_EXPECTED_HOOKS = 11` constant location | **Carried** — still in `bootstrap/start.ts:29` instead of next to `BUILTIN_REGISTRARS` (CONFIG-2). |
| MCP probe loop 60-s startup delay | **Carried** — `bootstrap/probes.ts:103-104` (latent `/readyz` flap). |
| Dead branches in `sandbox.ts:174-175` (CHEMCLAW_NO_NET advisory) | **Carried unchanged.** |

**New findings that didn't exist on the 2026-04-29 branch:** PARITY-1 (only one route flips on the resolver — the resolver was newer), ADMIN-1 (the legacy / new admin-table split is post-merge), ENVELOPE-1 (`errors/envelope.ts` was introduced but not adopted), CONFIG-1 (`AGENT_SHADOW_SAMPLE` redundant read).

---

## Implementation Order (suggested)

1. **PARITY-1** + **TYPES-1** (`AgentCallOptions.permissions`) — single PR. Plumbs the resolver into every harness call path; `permissions` is permissive on the `enforce` policy fallback so behavior unchanged when no policy matches.
2. **ENVELOPE-1** sweep — single mechanical PR.
3. **ADMIN-1** — separate PR with an explicit ADR (semantic change to `/api/eval`, `/api/optimizer`, `/api/skills/enable`).
4. **DEDUP-{1,2,3,4,5,6,7}** + **CONFIG-2** + **CONFIG-1** (shadow eval) + **TYPES-2,3** + **DR-1** — one or two cleanup PRs.
5. **DEAD-1** triage PR — one-by-one decisions, each with an ADR if deletion is non-trivial.
6. **TSCONFIG-1** flag flips — last, behind the surface fixes.
