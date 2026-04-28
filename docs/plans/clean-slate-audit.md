# Clean-slate audit — first and last run

> **Historical (2026-04-27):** references to the in-tree Streamlit
> frontend in this document are obsolete. The frontend has been removed
> and is being rebuilt in a separate repository. See
> `docs/superpowers/specs/2026-04-27-remove-frontend-add-cli-design.md`.

**Operating premise:** treat this as if no prior review exists. Every audit agent is briefed without reference to prior findings. Synthesize fresh, fix what matters, ship production-ready.

## Goal

Make the codebase production-ready and maintainable. Production-ready means:
- No exploitable security vulnerabilities at the application layer
- No silent error paths (every failure surfaces somewhere observable)
- No documented-but-not-implemented features (or, if any, explicitly deferred with a runbook entry)
- CI runs on PR and blocks broken changes
- Dependencies have a known security posture (`npm audit` / `pip-audit` clean or known-and-suppressed)
- Operational tasks have a runbook (deploy, rollback, debug)

Maintainable means:
- A new engineer can onboard in <1 day to make a non-trivial change
- The shape of one tool / one route / one projector is the same as every other
- Type-safety + tests would catch the most common mistakes a future change might make

## Scope

Full codebase. The previous rounds focused on the autonomy upgrade delta; this round audits everything. Specifically:

- All TypeScript in `services/agent-claw/`, `services/paperclip/`
- All Python in `services/mcp_tools/`, `services/projectors/`, `services/optimizer/`, `services/litellm_redactor/`, `services/frontend/`
- All SQL in `db/init/`, `db/seed/`
- All YAML / config (docker-compose, helm, hooks/, .github/)
- All docs (CLAUDE.md, AGENTS.md, READMEs, runbooks, ADRs)

## Phase 0 — Plan (this document)

Done. No code touched.

## Phase 1 — Parallel agent dispatch (read-only)

Nine specialized agents run simultaneously, each with a distinct remit so reports don't overlap. Confidence threshold ≥ 70% on every finding; skip nitpicks.

**1. security-auditor** — full security audit
- Auth/authz on every route
- RLS enforcement and bypass surface
- Injection (SQL, command, prompt)
- SSRF in any HTTP client
- Secrets handling + log leakage
- Crypto choices (HMAC, hashing, randomness sources)
- Sandbox / E2B isolation
- Error messages that leak internals
- CVE posture across npm + pip dependencies

**2. feature-dev:code-reviewer** — code review (TS focus)
- Control flow correctness in routes (chat.ts, sessions.ts, plan.ts, optimizer.ts)
- Error handling completeness (try/catch boundaries, finally semantics)
- Type safety escapes (`as any`, `as unknown as`, `// @ts-expect-error`)
- Async/await correctness (unawaited promises, race conditions)
- Null/undefined handling

**3. code-refactoring-specialist** — refactor + duplication scan
- DRY violations across services
- Magic numbers + magic strings
- Dead code (unwired exports, unused builtins, legacy paths)
- Naming inconsistency
- Premature abstractions / unused parameters
- Module-boundary violations

**4. debug-investigator** — edge cases + runtime correctness
- Off-by-one risks
- Race conditions
- Retry semantics (is failure recovery idempotent?)
- Network-failure paths
- Empty-input handling
- Time-of-check-time-of-use issues
- Resource leaks (connection pools, AbortControllers)

**5. test-engineer** — test coverage + quality
- Coverage gaps (which control paths have no test?)
- Weak assertions (`toBeDefined()` on the thing that's the whole point)
- Mocks of mocks
- Tests that pass with the implementation broken
- Missing integration tests for cross-module flows

**6. dependency-migration-specialist** — dependency hygiene
- Outdated packages (npm + pip)
- Version skew across services for shared libs
- Transitive bloat / unused deps
- License compatibility
- Pinning strategy (vs floating)

**7. general-purpose (1) — operational readiness**
- CI coverage and gates
- Structured logging consistency
- Error visibility (logged vs swallowed)
- Health probes accuracy
- Metric/observability gaps
- Deployment artifacts (Dockerfiles, Helm, compose)
- Runbook completeness

**8. general-purpose (2) — documentation audit**
- CLAUDE.md / AGENTS.md accuracy
- API documentation (OpenAPI/handwritten)
- Code-comment quality (WHY not WHAT)
- README freshness across services
- Runbook actionability

**9. feature-dev:code-architect** — architecture review
- Module-boundary cleanliness (which modules talk to which?)
- Abstraction leakage (e.g. core leaking route concerns)
- Data-flow comprehensibility
- Service-to-service coupling
- Single-responsibility-principle adherence
- Cyclic dependencies
- Plugin points: extending the system shouldn't need 10 file edits

## Phase 2 — Synthesis + triage

Compile all 9 reports into a single triaged backlog:
- **P0** — exploitable / broken / will block production
- **P1** — quality issue with real impact
- **P2** — refactor / docs / cleanup

Each finding gets: file_path:line, problem, fix, effort estimate, dependencies.

## Phase 3 — Execute by tier

Order maximizing safety + visibility:
1. **Security P0/P1** (commit 1) — anything exploitable. Smallest review-fee.
2. **Correctness P0** (commit 2) — race conditions, error-handling holes.
3. **Refactor: duplication + magic strings** (commit 3) — biggest mechanical maintainability win.
4. **Test coverage gaps** (commit 4) — add tests for the highest-risk paths.
5. **Operational P0** (commit 5) — CI gaps, monitoring, deployment artifacts.
6. **Documentation refresh** (commit 6) — fix everything stale.
7. **Polish** (commit 7) — type-safety tightening, structured logging consistency.

Each commit:
- All vitest pass
- `npx tsc --noEmit` clean
- pytest where Python touched
- Conventional commit message

## Phase 4 — Verification

After all commits land:
- Re-run all vitest tests
- Re-run all pytest tests
- `npm audit --audit-level=high` clean
- `npx tsc --noEmit` clean
- Manual smoke (where reasonable): SSE event ordering, session round-trip, todo CRUD, ask_user resume, MCP auth on/off

## Phase 5 — Push

Single push to the working branch. Branch ready for review/merge.

## Acceptance

The codebase is "production-ready" when:
- All P0 findings addressed (P1 either addressed or explicit waiver)
- CI gates pass
- Tests cover the highest-risk paths
- Documentation reflects what's actually implemented
- Operations runbook is actionable for deploy / rollback / debug
- `npm audit` and `pip-audit` show 0 high/critical vulns
- The branch passes a final read-through "would I be comfortable shipping this" test
