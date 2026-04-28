# ADR 007 — Hook System Rebuild: YAML Loader as Single Source of Truth

**Status:** Accepted
**Date:** 2026-04-28
**Context:** ChemClaw harness control-plane rebuild — Phases 1 + 4 (v1.2.0-harness)

---

## Context

The pre-rebuild hook system advertised a "5 hook points, register in
`lifecycle.ts`" model in CLAUDE.md, ADR 004, and the runbook. An audit done
ahead of v1.2 found that the actual code did not match the story:

- Four hook implementation files existed under
  `services/agent-claw/src/core/hooks/` but were **never registered** by the
  YAML loader (`apply-skills`, `compact-window`, `init-scratch`,
  `source-cache`). They had `*.yaml` definitions in `hooks/` but
  `BUILTIN_REGISTRARS` only knew about five names, so the loader logged
  "no built-in registrar" and moved on. Operators inspecting `hooks/` saw a
  configuration that the harness silently ignored.
- Two YAML files referenced hook names that had been renamed in code, so
  the loader skipped them with no log message at the right level.
- A separate `buildDefaultLifecycle()` factory in `harness-builders.ts`
  duplicated registration logic — routes called it, but the YAML loader
  populated a different lifecycle that nothing used in production. The two
  registration paths drifted independently.
- Net effect: ~50% of advertised hook coverage actually fired. Hooks that
  did fire used a bespoke `(scratchpad) => void` signature that diverged
  from the Claude Agent SDK's `HookJSONOutput` contract, so operators
  could not lift hooks from `.claude/settings.json`-shaped configs.

This is the kind of drift the audit-friendly architecture (YAML files
under `hooks/`) was supposed to prevent. The drift was possible because
the registration path was not actually driven by those YAML files.

---

## Decision

The YAML loader (`services/agent-claw/src/core/hook-loader.ts::loadHooks`)
is the **single source of truth** for hook registration. The orphan
`buildDefaultLifecycle()` factory is deleted. `index.ts`, sub-agents, and
all four route handlers (`/api/chat`, `/api/chat/plan/approve`,
`/api/sessions/:id/plan/run`, `/api/sessions/:id/resume`) read the
single global lifecycle that `loadHooks` populates at boot.

Concretely:

1. Every hook `.ts` file in `services/agent-claw/src/core/hooks/` has a
   matching YAML file in `hooks/` AND an entry in `BUILTIN_REGISTRARS`.
   `BUILTIN_REGISTRARS` now maps 10 hook names to registrars (was 5).
2. `HookDeps` (`{ pool, llm, skillLoader, allTools, tokenBudget }`) is
   the typed dependency bundle threaded into every registrar. Composition
   of dependencies happens in `index.ts` and is the one place where the
   wiring is visible.
3. The dispatcher contract is the Claude Agent SDK shape:
   `(input, toolUseID, { signal: AbortSignal }) => Promise<HookJSONOutput>`.
   Hooks return `{ hookSpecificOutput: { permissionDecision, permissionDecisionReason, updatedInput } }`
   or `{ async: true }` for fire-and-forget. The lifecycle aggregates
   decisions across all hooks at the same point with `deny > defer > ask
   > allow` precedence (`mostRestrictive` in `hook-output.ts`).
4. Each hook gets a per-call `AbortController` with a 60 s default
   timeout, matching the SDK's behaviour. Hooks that don't honour the
   signal still hold the dispatcher hostage — this is best-effort abort.
5. Optional regex matchers gate execution per dispatch — used today by
   `source-cache` (only fires for `query_*` / `fetch_*` tool names) and
   `tag-maturity` (only fires for retrieval-shaped tools).
6. The lifecycle was extended from 6 named points to 16 in Phase 4B
   (`session_start`, `session_end`, `user_prompt_submit`,
   `post_tool_failure`, `post_tool_batch`, `permission_request`,
   `subagent_start`, `subagent_stop`, `task_created`, `task_completed`,
   `post_compact`). All 16 are valid `lifecycle:` values in YAML.

---

## Rationale

**Why the YAML loader as single source of truth?** The audit-friendly
property only exists if `ls hooks/` is the operator-visible answer to
"what runs in this harness?" A second registration path is a second
place where the answer can drift; deleting it is the only way to make
drift impossible by construction. The loader's `HookLoadResult.skipped`
list (returned at every boot) makes silent failure observable.

**Why the SDK callback contract?** Operators familiar with Claude Code's
`.claude/settings.json` hook ecosystem can write equivalents here with
minimal translation. The decision-aggregation rule is documented and
matches the SDK's published behaviour. As the SDK gains hook-system
features, ChemClaw can pull them in without contract divergence.

**Why an `AbortSignal`?** A misbehaved third-party hook should not be
able to stop the harness. The signal lets cooperative handlers bail
when the timeout elapses; the timer is per-dispatch, not per-handler-
registration, so each invocation gets a fresh 60 s window.

---

## Consequences

- Adding a new hook requires **two** artifacts: a YAML file under `hooks/`
  AND an entry in `BUILTIN_REGISTRARS`. Forget either and the loader
  surfaces the gap (`HookLoadResult.skipped`). The "create a `.ts` file
  and forget the YAML" failure mode is gone.
- Hook callbacks now have a typed error contract instead of throw-only.
  `foundation-citation-guard` migrated from throw-on-violation to
  returning `permissionDecision: "deny"` — same outcome, parity with
  the SDK shape, and route-level handlers can read the structured reason.
- `pre_tool` retains throw-propagation semantics for
  back-compat (budget-guard's hard cap still throws); all other hook
  points log and continue, so a downstream `redact-secrets` cannot be
  starved by an upstream failure.
- The lifecycle has 16 hook points (was 6). Documentation and the
  PARITY tracker enumerate them; CLAUDE.md is the operator reference.

Related ADRs: 008 (collapsed ReAct loop), 009 (permission/decision
contract), 010 (deferred phases).
