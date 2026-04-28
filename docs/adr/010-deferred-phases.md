# ADR 010 — Deferred Phases (Out of `v1.2.0-harness`)

**Status:** Accepted
**Date:** 2026-04-28
**Context:** ChemClaw harness control-plane rebuild — closure (v1.2.0-harness)

---

## Context

The harness control-plane rebuild plan had eleven phases. Phases 0, 1A,
1B, 1C, 2A, 2B, 2C, 3, 4A, 4B, 4C, 5, 7, and 10 land in `v1.2.0-harness`.
Four phases (6, 8, 9, 11) are deferred to a v1.3 follow-up. This ADR
documents what is **not** in v1.2 and why, so reviewers have an explicit
scope boundary and operators know what is still expected.

---

## Decision

The following phases are deferred to `v1.3` and tracked in `docs/PARITY.md`:

### Phase 6 — Permission system foundation

**Scope:** Route-level resolver that combines `permissionMode`
(`default | acceptEdits | plan | dontAsk | auto | bypassPermissions`),
`allowedTools` / `disallowedTools` filters, and per-route hook
decisions; workspace-boundary validation for filesystem-scoped tools.

**Why deferred:** The harness contract (ADR 009) locks the hook side.
The route-level resolver needs design work — interactive `ask` flows
(elicit user → resume), `defer` budgeting semantics, and the tool-list
filter need a coherent UX before code lands. This is a v1.3 design +
implementation pair, not a harness change.

### Phase 8 — etag / chained / reanimator integration tests

**Scope:** Testcontainer-driven integration tests that exercise
session etag conflict resolution, `/api/sessions/:id/plan/run` chained
execution under token-budget exhaustion, and the reanimator daemon
round-trip (stalled todo → POST `/api/internal/sessions/:id/resume`).

**Why deferred:** Significant test infrastructure investment
(testcontainers, Postgres + Neo4j start-up cost, RLS-aware fixtures).
The audit-flagged session paths are correct by inspection (RLS-verified
in `db/init/13_agent_sessions.sql`; reanimator JWT scope verified in
ADR 006), but no testcontainer-driven test pins the behaviour today.
Phase 8 will land before any session-layer refactor.

### Phase 9 — Per-hook + per-tool Langfuse spans

**Scope:** Decorate every hook dispatch and every tool invocation with
an OTel span exported via the existing OTLP pipeline to Langfuse. Tag
spans with `hook.name`, `hook.point`, `tool.name`, `permission.decision`
so the cost / latency / decision-distribution data is queryable per
hook and per tool.

**Why deferred:** The OTLP exporter is wired in
`services/agent-claw/src/observability/`, but spans don't yet decorate
the hot paths. This is the next obvious observability work; it lands
once the v1.2 contract is in operator hands and we have real traffic
to instrument against. Doing it before v1.2 ships would be premature
optimization on a moving target.

### Phase 11 — Mock parity harness with scenario JSON files

**Scope:** A `tests/parity/` harness that replays scripted scenario
JSON files (à la `ultraworkers/claw-code`) through the agent and
asserts on the SSE wire format + final state. Lets us pin parity
with Claude Agent SDK behaviour as the SDK evolves.

**Why deferred:** Significant test-infrastructure work; needs a stable
permission story (Phase 6) and a stable observability story (Phase 9)
to be useful as a regression net. Defer until those land first.

---

## Consequences

- v1.2.0-harness ships with the harness rebuild proper: 16 hook points,
  unified ReAct loop, fail-closed MCP auth, parallel readonly batches,
  ADRs 007-009.
- v1.3 is scoped: permission resolver, integration tests, observability,
  parity harness. Each is a discrete, independently shippable piece.
- The deferral is documented in `docs/PARITY.md` so reviewers and
  operators can see the gap between "contract locked" and "fully
  enforced end-to-end" without reading source.

Related ADRs: 007, 008, 009.
