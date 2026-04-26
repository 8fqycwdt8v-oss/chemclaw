# Production-readiness round — extensive review + refactor + hardening

**Goal:** make the codebase production-ready and well-maintainable. The last 6 commits added significant new infrastructure (sessions, plans, todos, ask_user, MCP auth, RLS hardening, role split, ai SDK 5, vitest 3) on top of the existing v1.0.0-claw harness. Time for a top-to-bottom audit before any of this lands on `main` long-term.

## Scope

The whole codebase is in scope, but the **delta since the last big audit (commit `db388f0` — v1.0.0-claw merge)** gets the most attention because:
- It hasn't been independently reviewed
- It introduced ~20 new files and ~3000 lines of TypeScript / SQL / Python
- Several pieces (plan chaining, auto-resume, etag) have subtle correctness invariants that are easy to get wrong

Specific newly-changed surfaces:
1. **Session state** — `db/init/13_agent_sessions.sql`, `14_agent_session_extensions.sql`, `core/session-store.ts`, every consumer in `routes/`
2. **Plan v2** — `core/plan-store-db.ts`, the `/api/sessions/:id/plan/run` endpoint, the chained-execution helper
3. **Auto-resume** — `services/optimizer/session_reanimator/`, `/api/sessions/:id/resume`
4. **TodoWrite analog** — `tools/builtins/manage_todos.ts`, `tools/builtins/ask_user.ts`, the new SSE event types
5. **MCP Bearer-token auth** — `services/agent-claw/src/security/mcp-tokens.ts`, `services/mcp_tools/common/auth.py`
6. **RLS hardening** — `db/init/12_security_hardening.sql`, role-split docker-compose
7. **AI SDK 5 migration** — `services/agent-claw/src/llm/litellm-provider.ts`
8. **Source-system adapters** — `mcp_eln_benchling`, `mcp_lims_starlims`, `mcp_instrument_waters`

## Phase 0 — Plan (this document)

✓ Plan written. No code touched.

## Phase 1 — Parallel audit (read-only, ~30 min agent runtime)

Four agents run in parallel, each with a focused remit and a budget for high-confidence findings only. Skip nitpicks; report what actually matters.

**1a. Security audit** (`security-auditor` subagent)
Targets:
- New endpoints: `/api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/plan/run`, `/api/sessions/:id/resume`. Check for: auth gating, RLS enforcement, IDOR surface, request validation
- The `runChainedHarness` shared helper. Race conditions? Privilege escalation via session reload?
- The `session_reanimator` daemon. User impersonation surface? Loop guard adequacy? Connecting as `chemclaw_service` (BYPASSRLS) — is that constrained correctly?
- Plan chaining: DoS via infinite re-chains, budget bypass via plan-mode session, plan-step injection via the `initial_messages` JSON
- `ask_user` / `manage_todos`: prompt injection through stored questions or todo content, length-bound bypasses
- The new SSE event types: do `todo_update`, `awaiting_user_input`, `session` events leak data the redactor missed?
- Cross-cutting: any `pool.query` callsites that bypass `withUserContext` / `withSystemContext`
- Reanimator-impersonates-user pattern: `x-user-entra-id` header on inter-service calls — what stops a compromised mcp service from forging this?

**1b. Code review** (`feature-dev:code-reviewer` subagent)
Targets:
- The two big route files: `routes/chat.ts` (~700 LOC, dense control flow) and `routes/sessions.ts` (~300 LOC, two harness paths)
- `core/session-store.ts`: dynamic SQL string-building in `saveSession`. Injection-safe? Edge cases?
- `core/plan-store-db.ts`: status enum + transition logic
- `core/budget.ts`: the new `SessionBudgetSnapshot` parameter — is the additive logic correct under multi-turn replay?
- The chained-harness logic: termination conditions, error handling for `OptimisticLockError` mid-chain, message-history accumulation
- Type safety in the new code: any `as unknown as`, `any`, `// @ts-expect-error` in the autonomy paths
- Test coverage gaps: do we have a test for plan chaining hitting `max_steps` and re-chaining? For etag conflict resolution? For the reanimator skipping `awaiting_user_input` sessions?

**1c. Refactor + duplication scan** (`code-refactoring-specialist` subagent)
Targets:
- Lifecycle setup is duplicated in `chat.ts`, `plan.ts` (legacy approve), and `sessions.ts` (chained run). Extract a `buildDefaultLifecycle` shared by all three?
- Scratchpad hydration: same pattern in `chat.ts` and `routes/sessions.ts`. Extract a helper.
- Session save block (the dump-scratchpad-to-row code) appears in `chat.ts` finally and in `runChainedHarness`. DRY?
- The SSE `writeEvent` + `setupSse` helpers are duplicated in `chat.ts`, `plan.ts`, `sessions.ts`. Move to a shared module.
- Error envelope consistency: `chat.ts` emits SSE error events, `sessions.ts` returns JSON 400/404/409. Different shapes. Standardize.
- Discriminate-by-name antipattern in error handling: `err instanceof Error ? err.name : ""` + string compare. Use proper `instanceof` checks against the typed errors.
- Structured logging: which logs include `userEntraId` / `sessionId`? Inconsistent.

**1d. Documentation + maintainability** (general-purpose subagent)
Targets:
- `CLAUDE.md` is significantly out of date — it documents Phase F.2 but says nothing about sessions, todos, ask_user, plan chaining, etag, the autonomy upgrade, or MCP Bearer tokens. Production-readiness blocker.
- `services/agent-claw/AGENTS.md` — same.
- `docs/runbooks/` has the post-v1.0.0 runbook but no operational runbook for the new infrastructure (how do operators bump `auto_resume_cap`? How do they read the reanimator's logs?)
- README / .env.example — coverage of new env vars (`AGENT_SESSION_*`, `MCP_AUTH_SIGNING_KEY`, `CHEMCLAW_APP_*`, `MCP_AUTH_REQUIRED`)
- CI integration: is there a GitHub Actions workflow that runs the test suite? If yes, does it cover the Python services + the schema migrations?
- Code comments quality: spot-check for over-commenting / out-of-date comments / TODOs left from the autonomy work

## Phase 2 — Synthesis + triage

Compile the four reports into a single triaged backlog, classified:
- **P0** — exploitable / broken / will block production
- **P1** — quality issue with real impact
- **P2** — refactor / docs / cleanup

Each finding gets: file_path:line, problem, fix, effort estimate, dependencies.

## Phase 3 — Execute by tier (commit per logical group)

Order:
1. **Documentation refresh** — commit 1: update CLAUDE.md, AGENTS.md, .env.example, write new runbooks. Lowest blast radius, biggest "production readiness" win.
2. **Security P0/P1** — commit 2: anything that's exploitable or auth-bypass-adjacent.
3. **Correctness fixes** — commit 3: race conditions, error-handling holes, test coverage gaps.
4. **Refactor: extract shared helpers** — commit 4: the duplication cleanup. Biggest mechanical win for maintainability.
5. **Polish** — commit 5: type-safety tightening, structured logging consistency, comment cleanup.

Each commit:
- All vitest pass
- `npx tsc --noEmit` clean
- pytest where Python touched
- Conventional commit message with the finding ID(s) it addresses

## Phase 4 — Verification

After all commits land:
- Re-run all 657+ vitest tests
- Re-run all touched-services pytest
- `npx tsc --noEmit` and `python3 -m mypy services/projectors services/mcp_tools` (if mypy is wired)
- `npm audit` — confirm 0 vulnerabilities held
- Manual smoke checks (these are the production-readiness tells):
  - Spin up the stack via `make up.full`
  - Smoke a chat session → confirm `session` event fires, `manage_todos` round-trips, `ask_user` pauses + resumes
  - Verify `GET /api/sessions/:id` returns the live state
  - Confirm the reanimator daemon starts and logs no errors

## Out of scope (deliberate)

- **Sandbox isolation Layers 1 + 3** (custom E2B template, sandbox→agent RPC bridge). Tracked in ADR 006; multi-week ops project.
- **Per-tenant token-budget overrides via API**. The schema column exists; the admin endpoint to mutate it doesn't. Follow-up.
- **Multi-tenant auth proxy hardening** (oauth2-proxy / Entra ID setup). Production deploy concern; out of scope for code review.
- **Performance benchmarking**. We're not yet at the scale where this is the bottleneck.

## Acceptance

Branch is "production-ready" when:
- All four audit reports' P0/P1 findings are addressed or have explicit waivers (with rationale in the runbook)
- CLAUDE.md and AGENTS.md document the autonomy primitives accurately
- The chat / plan-run / resume flows have at least one integration-style test exercising the full path
- Operations runbook exists for: bumping `auto_resume_cap`, draining a session, reading reanimator logs, applying the schema migrations on an existing DB
- `npm audit` + Dependabot: 0 production-runtime alerts
- `make up.full && scripts/smoke.sh` succeeds (or the smoke script is updated to cover the new endpoints)
