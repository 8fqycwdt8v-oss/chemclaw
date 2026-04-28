# ADR 009 — Permission and Decision Contract

**Status:** Accepted. Route-level permission resolver landed in Phase 6
(v1.2.0-harness, 2026-04-27).
**Date:** 2026-04-28 (initial), 2026-04-27 (Phase 6 update)
**Context:** ChemClaw harness control-plane rebuild — Phase 4A (contract)
+ Phase 6 (resolver, modes, workspace boundary)

---

## Context

Claude Code ships a layered permission model that operators expect to be
able to lift directly into agent-claw configurations:

- `permissionMode: "default" | "acceptEdits" | "plan" | "dontAsk" | "auto" | "bypassPermissions"`
  controls the default disposition of tool calls.
- `allowedTools` / `disallowedTools` arrays filter the tool catalog
  per session.
- Hook callbacks return `PermissionDecision: "allow" | "deny" | "ask" | "defer"`
  via `hookSpecificOutput.permissionDecision`. The runtime aggregates
  decisions across multiple hooks at the same point with a most-
  restrictive-wins rule.

ChemClaw's pre-rebuild hook contract was a `(scratchpad) => void` shape
that signalled denial by throwing. Operators could not write hooks that
looked like Claude Code hooks; the agent had no place to put a
`permissionMode`-style configuration; and the throw-on-deny ergonomics
made it impossible to surface a structured reason to a UI.

---

## Decision

Adopt the Claude Agent SDK contract verbatim at the harness layer. The
route-level permission resolver (which interprets `permissionMode` +
`allowedTools` + the hook decision) is deferred to Phase 6, but the
**contract** that the resolver will read is locked here.

1. Hook callbacks return `HookJSONOutput` (`core/hook-output.ts`):
   ```ts
   {
     hookSpecificOutput: {
       hookEventName: "pre_tool",
       permissionDecision: "allow" | "deny" | "ask" | "defer",
       permissionDecisionReason: string,
       updatedInput?: Record<string, unknown>,
     }
   }
   ```
2. The lifecycle aggregates with **deny > defer > ask > allow** via
   `mostRestrictive`. One hook returning `deny` cannot be downgraded by
   a later hook returning `allow`. `permissionDecisionReason` follows
   whichever hook produced the most-restrictive decision.
3. `step.ts` honours two of the four decisions today:
   - `deny` — synthesise a tool rejection (`role: "tool"` message with
     a `permission_denied` payload + the reason). The model sees the
     denial and can replan.
   - `updatedInput` — re-parse through the tool's input schema before
     execution. Lets a hook normalise an input or substitute a safer
     variant.
   - `ask` and `defer` are treated as `allow` with a TODO log line in
     the `pre_tool` chain (legacy behaviour preserved).
     **Phase 6 update:** the new route-level resolver returns
     `defer` verbatim and short-circuits the call as a synthetic
     rejection; `ask` is still treated as allow until interactive
     elicit ships (see "Update (Phase 6)" below).
4. The `permission_request` hook point exists in the lifecycle (Phase
   4B) so operators can wire telemetry around the future resolver
   without code changes.

---

## Rationale

**Why adopt the SDK contract verbatim?** Operators familiar with
`.claude/settings.json` can write equivalents here with minimal
translation. Decision aggregation by most-restrictive-wins is the
documented SDK behaviour; reimplementing it differently would force
operators to maintain two mental models.

**Why lock the contract before the resolver lands?** The hook layer
ships independent of route-level permissions. Locking the contract now
means the route-level resolver in Phase 6 is a pure addition — no
harness rework — and any hook author writing for v1.2 can target the
final shape without rewriting for v1.3.

**Why treat `ask`/`defer` as `allow` for now?** A safe default. The
alternatives — silently denying or hard-failing — would either drop
work or make the contract awkward to roll out incrementally. The TODO
log line surfaces any hook returning these values so we know who's
relying on the eventual route-level handling.

---

## Consequences

- `foundation-citation-guard` migrated from throw-on-violation to
  `permissionDecision: "deny"` with a structured reason. Same outcome,
  parity with the SDK shape, route-level handlers can read the reason.
- `pre_tool` retains throw-propagation as a back-compat affordance
  (budget-guard's hard cap still throws to short-circuit the loop). New
  hooks should prefer `permissionDecision: "deny"`.
- The route-level permission resolver (Phase 6, v1.3) is the natural
  follow-up. This ADR locks the harness side so the resolver is purely
  additive — `permissionMode`, `allowedTools`, `disallowedTools`, and
  the `ask`/`defer` flows can all build on top without touching the
  harness or the hook contract.

Related ADRs: 007 (hook system rebuild), 008 (collapsed ReAct loop),
010 (deferred phases).

---

## Update (Phase 6) — Route-level resolver landed

The route-level resolver promised in this ADR is now live as
`services/agent-claw/src/core/permissions/resolver.ts`. It runs in
`step.ts` BEFORE `pre_tool` dispatch when `HarnessOptions.permissions`
is provided.

**Precedence (locked):**

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
   chain (deny>defer>ask>allow aggregation as before). If no hook
   produces a decision, call `permissionCallback` (when set);
   otherwise deny.

**Interaction with `pre_tool` hooks:** the resolver can short-circuit
to deny / defer (no `pre_tool` dispatch). On allow / ask, `pre_tool`
runs as before — a `pre_tool` hook can still downgrade to deny. So the
existing `foundation-citation-guard` deny path continues to work
without change.

**`ask` / `defer` semantics (Phase 6):** the resolver returns these
verbatim. `step.ts` treats `defer` as a synthetic rejection (deny
shape) so the model sees a `denied_by_permissions:defer` rejection
and replans. `ask` is currently treated as allow with a console.warn
(matching the pre-Phase-6 behaviour from the `pre_tool` chain) —
interactive elicit is still future work.

**Default no-op `permission_request` hook:** registered via
`hooks/permission.yaml` + `core/hooks/permission.ts`. Returns `{}` so
the resolver falls through to `permissionCallback` (or denies). Drop-in
attachment surface for operators who want a YAML-discoverable place to
plug in policy without code changes.

**Workspace boundary helper:** Phase 6 also added
`services/agent-claw/src/security/workspace-boundary.ts`
(`assertWithinWorkspace`) for filesystem-touching tools that take
user-supplied paths. The current chemclaw tool catalog has no such
tool (run_program runs inside an E2B sandbox isolated from the host
filesystem; mcp tools take SMILES / IDs / SQL filters, not paths), so
the helper is exported but not yet wired into a tool. It exists ready
for future filesystem-aware tools.
