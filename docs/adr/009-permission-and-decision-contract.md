# ADR 009 — Permission and Decision Contract

**Status:** Accepted. Route-level permission resolver landed in Phase 6
(v1.2.0-harness, 2026-04-27).
**Date:** 2026-04-27
**Context:** ChemClaw harness control-plane rebuild — Phase 6
(permission resolver, modes, allowedTools, workspace boundary).

---

## Context

Claude Code ships a layered permission model that operators expect to be
able to lift directly into agent-claw configurations:

- `permissionMode: "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions"`
  controls the default disposition of tool calls.
- `allowedTools` / `disallowedTools` arrays filter the tool catalog
  per session.
- Hook callbacks return a permission decision (`allow | deny | ask |
  defer`) and the runtime aggregates decisions across multiple hooks
  at the same point with a most-restrictive-wins rule.

Pre-Phase-6 chemclaw signalled denial by having a `pre_tool` hook
throw. Operators could not write hooks that looked like Claude Code
hooks; the agent had no place to put a `permissionMode`-style
configuration; and throw-on-deny ergonomics made it impossible to
surface a structured reason to a UI.

---

## Decision

Land a route-level permission resolver
(`services/agent-claw/src/core/permissions/resolver.ts`) that runs in
`step.ts` BEFORE `pre_tool` dispatch when `HarnessOptions.permissions`
is provided. The resolver translates the static rule layer
(`permissionMode` + `allowedTools` / `disallowedTools`) plus the
dynamic hook + callback chain into a single `PermissionResolution`.

### Precedence (locked)

1. `permissionMode === "bypassPermissions"` → allow.
2. `disallowedTools` matches → deny (wins over allowedTools).
3. `allowedTools` matches → allow. Trailing `*` wildcard supported
   (e.g. `mcp__github__*`) for MCP tool fan-out.
4. `permissionMode === "acceptEdits"` + tool is filesystem-touching
   (today: `run_program`, plus the SDK-shape ids `Write` / `Edit` /
   `MultiEdit` for parity) → allow.
5. `permissionMode === "plan"` → defer (route is expected to detect
   plan mode BEFORE entering the harness; defer here is defense-in-
   depth).
6. `permissionMode === "dontAsk"` → deny.
7. `permissionMode === "default"` → fire `permission_request` hook
   chain (deny>defer>ask>allow aggregation). If no hook produces a
   decision, call `permissionCallback` (when set); otherwise deny.

### Decision aggregation across hooks

Multiple `permission_request` hooks aggregate via deny > defer > ask
> allow. One hook returning `deny` cannot be downgraded by a later
hook returning `allow`. The reason follows whichever hook produced
the most-restrictive decision.

A permission hook may return either:

- The native chemclaw shape `{ decision, reason }` directly, or
- The Claude Agent SDK shape
  `{ hookSpecificOutput: { permissionDecision, permissionDecisionReason } }`.

The lifecycle's `dispatchPermissionRequest` normalises both shapes
before aggregating.

### Interaction with `pre_tool` hooks

The resolver can short-circuit to deny / defer (no `pre_tool` dispatch).
On allow / ask, `pre_tool` runs as before — a `pre_tool` hook can
still abort by throwing. Existing `foundation-citation-guard` and
`budget-guard` paths continue to work without change.

### `ask` / `defer` semantics

The resolver returns these verbatim. `step.ts` treats `defer` as a
synthetic rejection so the model sees a `denied_by_permissions:defer`
rejection and replans. `ask` is currently treated as allow with a
console.warn — interactive elicit is still future work.

### Default no-op `permission_request` hook

Registered via `hooks/permission.yaml` +
`services/agent-claw/src/core/hooks/permission.ts`. Returns
`undefined` so the resolver falls through to `permissionCallback`
(or denies). Drop-in attachment surface for operators who want a
YAML-discoverable place to plug in policy without code changes.

### Workspace boundary helper

Phase 6 also added `services/agent-claw/src/security/workspace-boundary.ts`
(`assertWithinWorkspace`) for filesystem-touching tools that take
user-supplied paths. The current chemclaw tool catalog has no such
tool (run_program runs inside an E2B sandbox isolated from the host
filesystem; mcp tools take SMILES / IDs / SQL filters, not paths), so
the helper is exported but not yet wired into a tool. It exists ready
for future filesystem-aware tools.

---

## Rationale

**Why a route-level resolver before `pre_tool`?** The static rule
layer (mode + allow/deny lists) is cheap to evaluate and expresses
operator intent declaratively. Putting it ahead of `pre_tool` means
the dynamic `pre_tool` chain only runs when the static rules don't
already settle the question. It also means a `bypassPermissions`
session never even fires the policy hook chain.

**Why deny-by-default in `default` mode with no hook + no callback?**
Fail-closed is the safer default. Operators who want a permissive
default explicitly set `bypassPermissions` (sandboxed envs) or wire
a `permissionCallback` returning `allow`.

**Why support both the native `{ decision, reason }` shape and the
SDK `hookSpecificOutput` shape?** Forward-compat with operators who
copy hooks from `.claude/settings.json` patterns. The lifecycle
normaliser hides the difference from the resolver.

**Why treat `ask` as `allow` with a warn for now?** Same reasoning
as Phase 4A: silently denying or hard-failing would either drop work
or make the contract awkward to roll out incrementally. Interactive
elicit will replace the warn when the elicit channel ships.

---

## Consequences

- `HarnessOptions.permissions` is optional. Routes that pass it in
  get the resolver; routes that don't (sub-agents, deep-research,
  plan.ts) preserve their prior `pre_tool`-only semantics.
- The hook count grew 9 → 10. The hook-loader-coverage test pins
  the new total and the per-point breakdown.
- `permission_request` is now a sixth hook lifecycle point. Hooks
  registered there return an optional `PermissionHookResult` (the
  other five points still return `Promise<void>`).

Related ADRs: 004 (harness engineering), 005 (data-layer revision),
006 (sandbox isolation).
