# Remaining follow-ups — implementation + ideation plan

Five open items from the production-readiness round, ordered by leverage and dependencies. Phases 1-4 are fully scoped; Phase 5 is intentionally ideation-only (multi-week ops work).

## Phase 1 — Test mock-pool helper *(target: 30 min, low risk)*

Pure cleanup. Three test files (`manage-todos`, `prompts-registry`, `skills-db`) duplicate a vi.fn() dispatcher that no-ops `BEGIN/COMMIT/SET_CONFIG` and routes data queries elsewhere.

**Design**
- New: `services/agent-claw/tests/helpers/mock-pool.ts`
- Exported: `createMockPool({ dataHandler })` returning `{ pool, dataSpy }`.
- `dataHandler(sql, params) → QueryResult` is the only thing tests configure.
- Transaction-control SQL (`BEGIN`, `COMMIT`, `ROLLBACK`, anything containing `SET_CONFIG`) is silently no-oped via a regex check. The helper recognizes the same set of patterns the existing three tests recognize.

**Acceptance**
- All three test files migrated; same passing test count (657 → 657).
- The helper is < 80 LOC.

## Phase 2 — MCP Bearer-token end-to-end wire *(target: 90 min, high value)*

The single biggest open security item. Today, `signMcpToken` and `verify_mcp_token` exist but are never invoked. Setting `MCP_AUTH_REQUIRED=true` would lock the cluster out.

**Design decisions:**

1. **Where does the agent get a token?** A per-process token cached for ~4 minutes (5-min TTL minus a 60s safety margin), keyed by `userEntraId` (so each user's outbound calls are tagged with their identity). Mint on cache miss; reuse on hit. Implemented in a tiny `mcp-token-cache.ts`.

2. **What scope does each call get?** Coarse-by-service for first cut: `mcp_kg:rw`, `mcp_doc_fetcher:fetch`, etc. Fine-grained per-tool scopes (`mcp_kg:write_fact`, `mcp_kg:query_at_time`) deferred — hard to maintain as tools change. Service-level scopes are added as a constant map in `mcp-token-cache.ts`.

3. **How does `postJson` get the user identity?** The existing signature is `(url, body, schema, timeoutMs, service)` — no user. Two options:
   - (a) Add an optional `userEntraId` parameter; threading it through every call site is ~20 edits across `tools/builtins/*`.
   - (b) Pass a token-minting closure as a constructor-time argument so callers don't change.
   
   I'll go with (a) for a smaller surface — the closure approach hides the user identity in a way that makes audit harder.

4. **What does the MCP service do?** `services/mcp_tools/common/app.py:create_app()` adds `Depends(require_mcp_token)` automatically. The dependency is already permissive in dev mode (`MCP_AUTH_REQUIRED=false`), so flipping the wire-up doesn't break local dev.

5. **What about the agent's outbound dev-mode story?** When `MCP_AUTH_SIGNING_KEY` is unset, `signMcpToken` throws — that's intentional in production but breaks `make up.full` for new contributors. Solution: when `MCP_AUTH_SIGNING_KEY` is unset, `getCachedMcpToken` returns `undefined` and `postJson`/`getJson` skip the Authorization header entirely. The MCP services (in dev mode) accept missing tokens with a warning. Net: dev works without setup, production sets the key + flips `MCP_AUTH_REQUIRED=true`.

**Plan**
1. `core/mcp-token-cache.ts` — `getMcpToken({userEntraId, service, ttlSeconds})` with in-process cache.
2. `mcp/postJson.ts` — accept optional `userEntraId` and `service` (already there). Add `Authorization: Bearer ...` header when key is configured.
3. `mcp/postJson.ts` — same for `getJson`.
4. Thread `ctx.userEntraId` through every `postJson`/`getJson` call site in `tools/builtins/*`. The tools all have `ctx` in scope.
5. `services/mcp_tools/common/app.py:create_app()` — add `dependencies=[Depends(require_mcp_token)]` to the FastAPI constructor. Routes inherit it.
6. Tests: a new `mcp-token-cache.test.ts` for the cache (TTL eviction, mint-on-miss). Update existing `postJson.test.ts` to assert the Bearer header when a key is set.

**Acceptance**
- With `MCP_AUTH_SIGNING_KEY` unset: dev works exactly as today (no Authorization header sent; MCP services accept).
- With `MCP_AUTH_SIGNING_KEY` set + `MCP_AUTH_REQUIRED=true`: agent → MCP calls succeed (token verified); a tampered/expired/missing token returns 401 from MCP.
- `npm test` passes. New cache tests pass.

## Phase 3 — Reanimator → agent JWT *(target: 30 min, depends on Phase 2)*

Currently the daemon forges `x-user-entra-id`. After Phase 2 the same JWT machinery can replace this.

**Design**

1. The agent gains a new endpoint: `POST /api/internal/resume` (instead of `POST /api/sessions/:id/resume` for daemon use). This route accepts a Bearer token where `claims.scopes` includes `agent:resume`. The route validates the token, extracts `claims.user`, and uses that as the impersonated `userEntraId`. **No `x-user-entra-id` header trust.**
2. The reanimator daemon mints a token per resume call (sub=`reanimator`, user=session's owner, scopes=`["agent:resume"]`).
3. Both share `MCP_AUTH_SIGNING_KEY` (rename to `CHEMCLAW_INTERNAL_SIGNING_KEY` for clarity? — but that means another env var. Keep the same key, document the dual use in CLAUDE.md.).

**Plan**
1. `services/agent-claw/src/routes/sessions.ts` — split `POST /api/sessions/:id/resume` into a public path that uses `getUser` (current behavior, kept for ops one-off use) AND `POST /api/internal/sessions/:id/resume` that requires a JWT with `agent:resume` scope and trusts the `claims.user` instead of the header.
2. New verifier helper in `services/agent-claw/src/security/mcp-tokens.ts` — `verifyInternalToken(authHeader, requiredScope)` that mirrors the Python verifier and returns `{user, sub} | null`.
3. `services/optimizer/session_reanimator/main.py` — mint a JWT (Python implementation in `services/mcp_tools/common/auth.py`) per session, send via `Authorization: Bearer ...`. Drop the `x-user-entra-id` header.

**Acceptance**
- Reanimator → agent calls succeed when key is configured.
- Forging `x-user-entra-id` against `/api/internal/...` returns 401 (no Bearer).
- Public `/api/sessions/:id/resume` still works with `x-user-entra-id` for one-off ops use (acceptable risk: ops console has different network gating).

## Phase 4 — Plan-step walking *(target: 90 min, product feature)*

Currently `agent_plans.steps` is decorative — the chained runner just feeds "Continue" prompts and lets the LLM call whatever tools it wants. This is good behavior on its own (the LLM has agency) but means the stored plan structure adds no enforcement.

**Design tradeoff**

Two orthogonal product paths:

| Path | LLM agency | Plan enforcement | Best for |
|---|---|---|---|
| (a) Strict step-walker | Low — harness explicitly invokes the next planned tool | High | Reproducible workflows (compliance, regulated ops) |
| (b) Plan-as-progress-tracker | High — LLM picks tools freely | Low (advisory) | Open-ended investigation |

I'll ship **(b) with explicit progress tracking** — it preserves the autonomy-product behavior and adds a `plan_progress` SSE event that the UI can render. Strict step-walking can be added later as an opt-in flag (e.g. `?strict=true` on the plan-run endpoint).

**Implementation:**
1. New SSE event type: `plan_progress` `{ plan_id, current_step_index, total_steps, last_step_status }`.
2. `core/plan-store-db.ts` — add `setStepDescription(plan_id, index, status, observation)` for marking individual steps.
3. After each chained iteration in `runChainedHarness`, fuzzy-match the LLM's tool calls against the stored `plan.steps[currentStepIndex]`. If the tool name matches → advance `current_step_index` + emit `plan_progress`. Fuzzy matching = exact tool-id match (good enough for first cut; semantic matching is a follow-up).
4. The `manage_todos` builtin already exists for the LLM to track its own progress; `plan_progress` is purely a server-side projection of "is the LLM still on plan?".

**Acceptance**
- A 5-step plan run via `POST /api/sessions/:id/plan/run` emits at least one `plan_progress` event per matching step.
- If the LLM deviates entirely (calls only tools not in the plan), `current_step_index` never advances — but the chain still runs to completion or budget exhaustion. No false-positive "plan completed" claims.
- Test: a fixture plan with 3 steps + a stub LLM that calls those 3 tools in order → 3 `plan_progress` events emitted + plan status = `completed`.

## Phase 5 — ADR 006 Layers 1 + 3 *(ideation only — multi-week ops project)*

Not implementing in this round. Documenting the design so the work is unblocked when ops capacity arrives.

### Layer 1 — iptables-firewalled E2B template

**Goal:** Sandboxed Python in `run_program` cannot reach the public internet OR the in-cluster MCP services directly. All egress goes through an agent-controlled proxy.

**Design:**
1. Custom E2B template `chemclaw-python-sandbox` builds from `e2bdev/code-interpreter:python` + an iptables OUTPUT rule chain installed at boot:
   ```bash
   iptables -P OUTPUT DROP
   iptables -A OUTPUT -o lo -j ACCEPT                    # loopback
   iptables -A OUTPUT -d $AGENT_PROXY_CIDR -p tcp \
     --dport 4001 -j ACCEPT                              # agent's egress proxy
   ```
2. The agent runs an "egress proxy" listener (new HTTP service or extension on port 3101) at the well-known address sandboxes can reach. The proxy:
   - Validates the sandbox's per-instance JWT (issued by the agent at sandbox creation, scoped to that sandbox)
   - Re-runs the call through the harness `pre_tool` / `post_tool` lifecycle so all hooks (citation guard, source-cache, redact-secrets) fire
   - Forwards to the real MCP service with an MCP-scope JWT
3. Template build via GitHub Actions on changes to `infra/e2b/template/`.

**Effort:** ~2 weeks. New service, ops-side template registry, integration tests against E2B.

### Layer 3 — Sandbox → agent RPC bridge

**Goal:** Sandbox-originated MCP calls go through the parent agent's lifecycle hooks, not direct HTTP.

**Design:**
- The stub library injected into the sandbox replaces direct `urllib.request.urlopen("http://mcp-kg:8003/...")` with `chemclaw.rpc("mcp_kg.write_fact", args)` calls.
- `chemclaw.rpc` reads/writes to a stdin/stdout RPC channel back to the agent via the E2B SDK's `process.stdin` / `process.stdout`.
- Agent reads RPC messages, dispatches them through the same `lifecycle.dispatch("pre_tool"...)` path that direct tool calls use, runs the tool, returns the result on the RPC channel.
- Net effect: sandbox-originated MCP calls become indistinguishable from agent-originated ones at the lifecycle layer.

**Effort:** ~3 weeks. New RPC protocol design, agent-side worker thread for handling sandbox RPC, tests covering deadlock scenarios.

### Decision

Both Layers 1 + 3 are deferred to a dedicated multi-week ops project tracked separately. ADR 006 in `docs/adr/006-sandbox-isolation.md` already documents Layer 2 (shipped Round 1) and notes Layers 1 + 3 are pending.

## Execution order in this session

1. **Phase 1** — mock-pool helper. Quick warm-up, contained.
2. **Phase 2** — MCP token wire. Highest-value security item.
3. **Phase 3** — reanimator JWT. Depends on Phase 2.
4. **Phase 4** — plan-step walking. Product feature.
5. **Phase 5** — ideation already in this doc; no code.

Each phase: own commit. Each commit: vitest green, tsc clean, pytest green for any touched Python.
