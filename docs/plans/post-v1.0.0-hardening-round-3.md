# Post-v1.0.0-claw hardening — Round 3 implementation plan

> **Historical (2026-04-27):** references to the in-tree Streamlit
> frontend in this document are obsolete. The frontend has been removed
> and is being rebuilt in a separate repository. See
> `docs/superpowers/specs/2026-04-27-remove-frontend-add-cli-design.md`.

Tackles the five items left open at the end of `docs/runbooks/post-v1.0.0-hardening.md`:

1. **vitest** major bump (clear 5 dev-only npm mediums)
2. **W2.3** Empty-user RLS fall-through removal + docker-compose role migration
3. **ai SDK** 4 → 5 (Vercel AI SDK)
4. **graphiti-core** 0.4.7 → 0.28+ (Cypher-injection patch)
5. **ADR 006** sandbox isolation — implementation

Each is independently shippable. The order below is "lowest risk first / smallest blast radius first" so a failure on a later phase doesn't block the earlier wins.

## Phase 1 — vitest major bump *(target: < 1 hour, dev-only)*

### Why first
- Dev-tooling only; no production runtime change.
- The remaining 5 medium Dependabot alerts (`vite`, `esbuild`, `@vitest/mocker`, `vite-node`, `vitest`) are all transitive through vitest's pinned vite/esbuild. A vitest major bump pulls in patched versions and clears all 5 alerts at once.
- 637/637 tests already pass; the bump's blast radius is "do tests still pass."

### Plan
1. Inspect current vitest pins in `services/agent-claw/package.json`, `services/paperclip/package.json`, root.
2. Bump to vitest ≥ 3 (which depends on vite ≥ 6 for the patched path-traversal fix).
3. Run `npm install` at the root + each workspace.
4. Run all tests; fix any vitest-3 API differences (most common: `vi.mocked` typing, `expect.extend` types, mock auto-cleanup semantics).
5. Re-run `npm audit`; confirm the 5 medium alerts clear.

### Risks
- Tests that rely on vitest 2-specific behavior (e.g. `vi.useFakeTimers()` semantics) may need touch-ups.
- vite 6 changed dev-server defaults; vitest still uses vite under the hood for its `transform` pipeline so an esbuild-related test fixture might trip.

### Acceptance
- `npm test` green across all three workspaces.
- `npm audit` shows 0 high/medium/low vite/esbuild/vitest alerts.

---

## Phase 2 — W2.3 RLS fail-closed + role split *(target: 1-2 hours)*

### Why second
- The schema change (FORCE RLS, new roles) already shipped in `db/init/12_security_hardening.sql`. What's missing is the **connection-side migration** — services still mostly connect as the table-owner role.
- Without this phase, the `withUserContext`/`withSystemContext` plumbing from Round 2 has no teeth: every connection bypasses RLS by being the owner.

### Plan

1. **Add app + service env vars to `docker-compose.yml`** (top-level + per-service):
   ```yaml
   x-chemclaw-app-env: &app-env
     POSTGRES_HOST: postgres
     POSTGRES_PORT: 5432
     POSTGRES_DB: ${POSTGRES_DB:-chemclaw}
     POSTGRES_USER: ${CHEMCLAW_APP_USER:-chemclaw_app}
     POSTGRES_PASSWORD: ${CHEMCLAW_APP_PASSWORD:-chemclaw_dev_password_change_me}
   x-chemclaw-service-env: &svc-env
     POSTGRES_HOST: postgres
     POSTGRES_PORT: 5432
     POSTGRES_DB: ${POSTGRES_DB:-chemclaw}
     POSTGRES_USER: ${CHEMCLAW_SERVICE_USER:-chemclaw_service}
     POSTGRES_PASSWORD: ${CHEMCLAW_SERVICE_PASSWORD:-chemclaw_dev_password_change_me}
   ```

2. **Wire each service to its correct anchor:**
   - `agent-claw` → `*app-env` (gets RLS-scoped reads via withUserContext)
   - `frontend` (Streamlit) → `*app-env`
   - `paperclip` → `*app-env`
   - All projectors (`reaction-vectorizer`, `chunk-embedder`, `contextual-chunker`, `kg-experiments`, `kg-source-cache`, `kg-hypotheses`) → `*svc-env`
   - `gepa-runner`, `skill-promoter`, `forged-tool-validator` → `*svc-env`
   - `litellm` and the MCP tool services don't connect to chemclaw Postgres directly (most don't need it; `mcp-kg` connects to Neo4j only) — leave alone.

3. **Update `db/init/12_security_hardening.sql`:**
   - Remove the `current_setting(...) IS NULL OR ... = ''` permissive branches from the legacy 01_schema.sql policies. Now that every service connects as either chemclaw_app (RLS-enforced) or chemclaw_service (BYPASSRLS), the empty-user fall-through has no legitimate caller.
   - Idempotency: use DROP POLICY + CREATE POLICY with the new fail-closed predicate.

4. **Verify:**
   - `docker compose down -v && docker compose up -d` (or follow `make nuke && make up`).
   - Connect to Postgres as `chemclaw_app` with `app.current_user_entra_id` unset → SELECT on RLS tables returns zero rows. Set the user → rows visible per project membership.
   - Connect as `chemclaw_service` → all rows visible regardless.
   - Run integration smoke (existing `scripts/smoke.sh`).

### Risks
- Any service we miss in step 2 will fail to start (chemclaw_app doesn't have the owner privileges its old code expected).
- Cross-tenant isolation can mask bugs; need to verify with a multi-user test (two seeded users in separate projects, `make db.seed`).

### Acceptance
- Services boot with `make up.full`.
- A query-as-user-A reading user-B's project returns 0 rows.
- Smoke test passes end-to-end.

---

## Phase 3 — ai SDK 4 → 5 migration *(target: 1-3 hours)*

### Why third
- Single-version-line bump within a stable library, but breaking. Must be done carefully because `LiteLLMProvider` is the egress chokepoint.
- File-upload bypass is the actual CVE; ChemClaw doesn't expose user-driven uploads through the AI SDK so the immediate exposure is bounded — but staying on a known-vulnerable major is bad form.

### Plan

1. Use context7 to fetch the AI SDK v5 migration guide.
2. Identify breaking changes that ChemClaw uses:
   - **Message format**: v5 changes `Message` → `UIMessage`/`ModelMessage` distinction. Search for `import { Message }` and `Message[]` parameter usage.
   - **Tool format**: v5 may change `tool({...})` shape (parameters → inputSchema, etc.).
   - **Streaming**: v5 reworks `streamText` chunk shapes — `text-delta`, `tool-call`, `tool-result`, `finish` may be renamed/restructured.
   - **Tool execution**: v5 distinguishes server-tools vs client-tools.
3. Bump `ai` and `@ai-sdk/openai` (or whichever provider is wired) in `services/agent-claw/package.json`. Root `package.json` workspaces will resolve automatically.
4. Update:
   - `services/agent-claw/src/llm/litellm-provider.ts` — primary impl.
   - `services/agent-claw/src/llm/provider.ts` — interface + StubLlmProvider.
   - Anywhere `streamText` / `generateText` / `tool` is called.
5. Run vitest suite, fix any test breakage.
6. `npx tsc --noEmit` clean.

### Risks
- v5 may require Node ≥ 20 / TypeScript ≥ 5.5 — already met.
- The `tools` argument shape change could mean every tool description/schema needs reformatting at the LLM call boundary.

### Acceptance
- 637 vitest pass.
- Smoke a real `/api/chat` call (mock LLM) end-to-end.
- Dependabot AI SDK alert clears.

---

## Phase 4 — graphiti-core 0.4.7 → 0.28+ *(target: 2-4 hours)*

### Why fourth
- Largest API delta (24 minor versions); highest risk of test breakage.
- ChemClaw's KG writes use static type strings, not user-controlled labels — so the Cypher injection CVE is bounded — but staying on 0.4 leaves us 24 versions behind on bug fixes.

### Plan

1. Use context7 to fetch graphiti-core docs / migration guide.
2. Inspect current usage in `services/projectors/kg_hypotheses/main.py`. Look for:
   - `Graphiti(...)` constructor args
   - `add_episode(...)` signature
   - `search(...)` filter args (the vulnerable surface)
   - `MERGE`/`MATCH` query helpers
3. Bump `graphiti-core==0.4.7` → `graphiti-core>=0.28.2,<1` in `services/projectors/kg_hypotheses/requirements.txt`.
4. Run `python3 -m pip install --upgrade graphiti-core` in a clean venv to surface import errors.
5. Update `kg_hypotheses/main.py` to the new API shape.
6. Add a migration note in the runbook documenting Graphiti DB schema changes (Graphiti often adds new node/edge labels per minor; running on an existing Neo4j DB may need a `bootstrap()` or migration script).
7. Run `services/projectors/kg_source_cache/tests/` and any kg_hypotheses tests.
8. Smoke against running Neo4j.

### Risks
- Graphiti 0.5+ rewrote the search/filter interfaces. Most likely impact: `search()` calls now take a `SearchFilters` dataclass instead of kwargs.
- Graphiti 0.7+ changed `Graphiti.__init__` to accept an `LLMConfig` object.
- Graphiti 0.20+ introduced multi-tenant `group_id` on every node — may need to backfill existing data.
- Embedding provider plumbing changed across versions.

### Acceptance
- `kg_hypotheses` boots and processes a sample event without crashing.
- pytest green.
- Dependabot graphiti alert clears.

---

## Phase 5 — ADR 006 sandbox isolation *(target: 2-4 hours partial)*

### Why last
- Multi-week if done fully. Partial credit is acceptable: ship the **JWT signing infra + Bearer auth middleware** so MCP services demand authenticated callers; defer the iptables-firewalled E2B template to ops.

### Plan (partial — what we can ship in one session)

1. **`services/agent-claw/src/security/mcp-tokens.ts`** — new module:
   - `signMcpToken({ sandboxId, userEntraId, scopes, ttlMs })` returns an HS256-signed JWT.
   - HMAC key from `MCP_AUTH_SIGNING_KEY` env var; default to a dev placeholder so `make up` keeps working.
   - 5-minute default TTL.
2. **`services/mcp_tools/common/auth.py`** — new module:
   - `verify_mcp_token(token, expected_audience)` returns `{sandbox_id, user, scopes}` or raises.
   - HMAC key from same env var (services share it via Kubernetes Secret in prod).
   - Skip-on-no-key dev mode flag (`MCP_AUTH_REQUIRED=false`).
3. **`services/mcp_tools/common/app.py`** — wire a FastAPI dependency that calls `verify_mcp_token` on every `/tools/*` route (skip for `/healthz`/`/readyz`). Fail-open in dev mode (warn) so existing tests still pass.
4. **`services/agent-claw/src/core/sandbox.ts`** — when minting a sandbox, also mint a JWT and inject as `CHEMCLAW_MCP_TOKEN` env var. The stub library reads it on every call.
5. **`run_program.ts` stub library** — add `Authorization: Bearer ${CHEMCLAW_MCP_TOKEN}` to every HTTP call.
6. **Tests:**
   - JWT round-trip (sign → verify) with valid + tampered + expired tokens.
   - `verify_mcp_token` rejects wrong audience, expired, tampered.
7. **Update ADR 006:** mark the JWT layer as shipped; the iptables template + RPC bridge remain deferred.

### Out of scope for this round
- iptables-firewalled E2B template — needs ops collaboration.
- Sandbox→agent RPC bridge for hook re-injection — design + impl is its own multi-week project.

### Risks
- Adding auth middleware to MCP services may break existing tests that don't pass a token. Mitigate via `MCP_AUTH_REQUIRED=false` default in dev/test.

### Acceptance
- New JWT round-trip tests pass.
- All existing 637 + 42 tests still pass (with `MCP_AUTH_REQUIRED=false` default).
- Production deploy can flip `MCP_AUTH_REQUIRED=true` and require tokens.

---

## Cross-cutting acceptance criteria

After all five phases:
- `npm test` (agent-claw): 637+ pass
- `pytest` (changed services): green
- `npx tsc --noEmit`: clean
- `npm audit` + Dependabot: 0 high, 0 medium production-runtime alerts (dev-only mediums acceptable but ideally also clear)
- `make up.full && scripts/smoke.sh` succeeds end-to-end

## Commit plan

One commit per phase, plus one final commit if any cross-cutting fix is needed:
1. `chore(deps): bump vitest to v3 — clears transitive vite/esbuild alerts`
2. `feat(security): role-split connection migration + fail-closed RLS`
3. `chore(deps): migrate ai SDK 4 → 5`
4. `chore(deps): migrate graphiti-core 0.4.7 → 0.28+`
5. `feat(security): MCP service Bearer-token authentication (ADR 006 partial)`

Each commit's body lists the breaking-change resolution + the test coverage that demonstrates it works.
