# ADR 010 — Deferred Phases: Retrospective + Remaining v1.4 Deferrals

**Status:** Accepted (revised 2026-04-29)
**Date:** 2026-04-28 (original) — superseded 2026-04-29
**Context:** ChemClaw harness control-plane rebuild — closure

---

## Context

The harness control-plane rebuild plan had eleven phases. The original
v1.2.0-harness closure (commit `ecc2fc0`, dated 2026-04-28) deferred
Phases 6, 8, 9, and 11 to a v1.3 follow-up. Between that closure and
the merge to a release branch, those four phases landed on the same
working branch (commits `73c93ac` through `c0c949e`, 2026-04-28..29).

This ADR was originally written as a forward-looking deferral
statement; it is rewritten here as a **retrospective** of what
followed, plus the remaining v1.4 deferrals that are still genuinely
out of scope.

---

## What landed after the original closure

The following items were marked "deferred (Phase 6/8/9/11, v1.3)" in
the first draft of `docs/PARITY.md` and ADR 010, then implemented on
the same branch before merge:

### Phase 6 — Permission system foundation

- Route-level resolver
  (`services/agent-claw/src/core/permissions/resolver.ts`) combines
  `permissionMode` (`default | acceptEdits | plan | dontAsk |
  bypassPermissions`), `allowedTools` / `disallowedTools` filters, and
  per-route hook decisions.
- `permission_request` lifecycle point fires when `ask` / `defer`
  decisions surface; the `permission` hook
  (`services/agent-claw/src/core/hooks/permission.ts`) gates flow.
- Workspace-boundary validation
  (`services/agent-claw/src/security/workspace-boundary.ts`) rejects
  filesystem-shaped tool inputs that resolve outside the configured
  workspace root.
- Tested by `tests/unit/permission-mode.test.ts` and
  `tests/unit/workspace-boundary.test.ts`.

### Phase 8 — etag / chained / reanimator integration tests

- Testcontainer harness
  (`services/agent-claw/tests/helpers/postgres-container.ts`) spins up
  a Postgres + RLS-aware fixture per suite.
- `tests/integration/etag-conflict.test.ts` exercises optimistic
  concurrency on `agent_sessions.etag`.
- `tests/integration/chained-execution.test.ts` exercises
  `/api/sessions/:id/plan/run` token-budget exhaustion and per-session
  budget enforcement.
- `tests/integration/reanimator-roundtrip.test.ts` exercises the
  stalled-todo → POST `/api/internal/sessions/:id/resume` round-trip
  and verifies the reanimator's JWT scope contract.

### Phase 9 — Per-hook + per-tool spans

- `services/agent-claw/src/observability/hook-spans.ts` decorates each
  hook dispatch with an OTel span tagged `hook.name`, `hook.point`,
  `permission.decision`.
- `services/agent-claw/src/observability/tool-spans.ts` decorates each
  tool invocation with `tool.name` and parent-context propagation.
- Tested by `tests/unit/observability-spans.test.ts`.

### Phase 11 — Mock parity harness with scenario JSON files

- `tests/parity/runner.ts` + `tests/parity/scenario.ts` replay scripted
  agent runs from JSON definitions; assertions cover SSE wire format
  + final state.
- 8 canonical scenarios under `tests/parity/scenarios/` exercise:
  tool-call-then-text, deny-precedence, todo-lifecycle, text-only,
  permission-deny-via-mode, ask-user-pause, parallel-readonly-batch,
  pre-compact-fires.

`docs/PARITY.md` flips the corresponding rows from `deferred` to
`implemented` and points at the file/symbol that backs each claim.

---

## What remains genuinely deferred (v1.4+)

The following primitives are still **not** in this release. They are
tracked in `docs/PARITY.md` with status `deferred (v1.4+)`:

### Setting sources (user / project / local)

**Scope:** Three-tier configuration cascade matching Claude Code's
`~/.claude/settings.json` (user) → `<project>/.claude/settings.json`
(project) → `<project>/.claude/settings.local.json` (local) layout.
Currently, all configuration is environment-variable driven.

**Why deferred:** The config-cascade design intersects with secret
handling and the redactor's redaction rules in non-trivial ways. A
clean design pass is needed before code lands; this is a v1.4 design +
implementation pair.

### ToolSearch (lazy tool loading)

**Scope:** A registry shape where tools are referenced by name in the
LLM-visible tool list but their full JSONSchema is loaded only when
the agent decides to invoke them — matching the "deferred tools"
pattern Claude Code uses for MCP servers.

**Why deferred:** Saves LLM context on long tool lists, but only
matters when ChemClaw's tool count crosses ~50 and the per-turn token
cost of the tool list becomes material. Today the registry is at ~36
builtins + chemistry MCPs; not yet a budget item.

### Effort levels (low/medium/high/xhigh/max)

**Scope:** Per-call inference effort knob borrowed from Claude Code's
prompt control surface.

**Why deferred:** LiteLLM does not expose the `effort` parameter
uniformly across providers; ChemClaw routes through LiteLLM as a
single egress chokepoint and does not bypass it. A custom translation
layer would be needed; not justified yet.

### Cost-correct streamed-text refactor (ADR 008 follow-up)

**Scope:** Today text turns make 2× LLM round-trips (one for the
finishReason / token estimate, one for the streamed text). A
single-call streaming pipeline would halve LLM cost on text-heavy
turns.

**Why deferred:** Functionally correct as-is; correctness work has to
land before cost-optimization work. Tracked in `core/harness.ts`
TODO and ADR 008's "future work" section.

---

## Consequences

- v1.2.0+harness ships with **all originally-numbered phases of the
  rebuild plan** (0 through 11). The originally-deferred phases (6, 8,
  9, 11) landed on the same working branch as the rebuild proper.
- The remaining v1.4 deferrals are scope-limited and individually
  shippable; none is a prerequisite for the others.
- Reviewers reading the ADR sequence (007 → 010) get a coherent
  narrative: contract → reduction-to-one-loop → decisions →
  retrospective + what's still pending.

Related ADRs: 007 (hook system rebuild), 008 (collapsed ReAct loop),
009 (permission and decision contract).
