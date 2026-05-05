# A04 Harness Audit — 2026-05-05

Scope: services/agent-claw/src/core/{harness,lifecycle,step,session-state,session-store,plan-store-db,sub-agent,chained-harness,compactor,budget,confidence,skills,sandbox,paperclip-client,plan-mode,slash,streaming-sink,types,runtime,request-context}.ts plus core/permissions/*.ts and core/hooks/*.ts (11 files).

Verified against HEAD = 09d2661 (Tier-1 A02 merge, prior to any A03/A04 changes).

## Verification matrix

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | Single Lifecycle singleton | clean | `rg "new Lifecycle\(" services/agent-claw/src --type ts \| grep -v tests/` returns only `core/runtime.ts:22`. All test instantiations are isolated under `tests/`. |
| 2 | MIN_EXPECTED_HOOKS gate | clean | `bootstrap/start.ts:29` MIN=11; `hooks/*.yaml` count=11; `BUILTIN_REGISTRARS` entries=11 (lines 117–147 of `core/hook-loader.ts`). All three values agree. |
| 3 | Hook AbortSignal honoring | clean | All 11 hook handlers accept `(payload, toolUseID, options)` shape. The three hooks with awaited I/O propagate `options.signal`: `compact-window` (passes signal into `compact()` summarizer call, `compact-window.ts:67`), `tag-maturity` (skips DB write when `signal?.aborted`, `tag-maturity.ts:102`), `source-cache` (early return when `options.signal.aborted`, `source-cache.ts:503`). Pure-CPU hooks (redact-secrets, anti-fabrication, init-scratch, apply-skills, budget-guard, foundation-citation-guard, permission, session-events) have no awaitable steps to abort — finish in <1ms. |
| 4 | runHarness `permissionMode: "enforce"` sites | clean | 6/6 expected sites present: `routes/chat.ts:405`, `routes/deep-research.ts:177` and `:230`, `routes/plan.ts:115`, `core/sub-agent.ts:191`, `core/chained-harness.ts:214`. No additional `runHarness(...)` call sites in production. |
| 5 | AsyncLocalStorage RequestContext propagation | clean | `runWithRequestContext` wrappers at: `routes/chat.ts:581`, `routes/plan.ts:96`, `routes/deep-research.ts:308`, `routes/documents.ts:48`, `core/chained-harness.ts:93`. Sub-agent inherits parent's ALS frame transparently (no own wrapper needed; comment at `sub-agent.ts:8` confirms inheritance is intentional). All wrappers seed `userEntraId`, `signal`, `requestId`, and pre-computed `userHash`. |
| 6 | `syncSeenFactIdsFromScratch` consistency | clean | Only one `lifecycle.dispatch("pre_turn", ...)` call exists outside test files: `core/harness.ts:102`, immediately followed by `syncSeenFactIdsFromScratch(ctx)` at `:109`. No manual route-level pre_turn dispatches remain. |
| 7 | Hook execution order | clean | `core/hook-loader.ts:230-235` sorts ascending by `order` (default 100) with filename `localeCompare` tiebreaker. No YAML in `hooks/*.yaml` declares an explicit `order:` today, so all 11 fall back to filename ordering — the implicit alphabetical sequence within each lifecycle phase is harmless given the actual hook semantics (no within-phase data dependencies). `tests/unit/hook-loader.test.ts` 10/10 passing. |
| 8 | VALID_HOOK_POINTS dispatch coverage | clean (16/16 — note CLAUDE.md drift below) | Every entry in `VALID_HOOK_POINTS` has at least one production dispatch site. Mapping:<br/>• pre_turn → harness.ts:102<br/>• pre_tool → step.ts:144<br/>• post_tool → step.ts:221<br/>• pre_compact → harness.ts:169, chat-compact.ts:36<br/>• post_compact → harness.ts:178, chat-compact.ts:44<br/>• post_turn → harness.ts:253<br/>• session_start → chat.ts:196, chained-harness.ts:184<br/>• session_end → chat.ts:497, chained-harness.ts:369<br/>• user_prompt_submit → chat.ts:185<br/>• post_tool_failure → step.ts:206<br/>• post_tool_batch → step.ts:374<br/>• permission_request → resolver.ts:118, :130<br/>• subagent_start → sub-agent.ts:171<br/>• subagent_stop → sub-agent.ts:205, :223<br/>• task_created → manage_todos.ts:132<br/>• task_completed → manage_todos.ts:163, :184<br/>**No dispatch-only points remain** — the F-4-era count of 9 is now 0. |
| 9 | hydrateScratchpad / persistTurnState consistency | clean | `routes/chat.ts` hydrates (`:166`) → harness runs → persists (`:460`). `core/chained-harness.ts` hydrates (`:171`) → harness runs → persists (`:245`) per iteration; final `session_end` re-hydrates from saved row (`:349`). `routes/plan.ts:63` and `routes/deep-research.ts:143` hydrate from `{}` (no session backing) and intentionally do not persist — both are single-turn with no `agent_sessions` row to update. Order is correct everywhere. |

## Drift from CLAUDE.md "Harness primitives" (lines ~317+)

CLAUDE.md states:

> **`permission_request`** — Resolver in `core/permissions/resolver.ts` (Phase 6) … Resolver wired in `core/step.ts` but only fires when a route passes `permissions` to `runHarness`; **no production route does today**, so the chain runs only in tests.

This is **stale**. As of HEAD 09d2661, six production sites pass `permissions: { permissionMode: "enforce" }` to `runHarness`: chat, deep-research (×2), plan, sub-agent, chained-harness. The permission resolver fires on every production tool dispatch, and the `permission_request` hook's DB-backed `permission_policies` chain is consulted on every tool call. CLAUDE.md should be updated; the resolver's own header comment (`core/permissions/resolver.ts:5-8`) carries the same stale "no production route" claim and is also wrong.

Filed in BACKLOG: `[docs/CLAUDE.md] permission_request stale "no production route" claim — six sites enforce as of 09d2661`.

## Cross-cutting issues queued for other agents

None directly attributable to other Tier-2 lanes from this review. The CLAUDE.md drift above is a doc-only fix (DOC-04 territory, not DR-04).

## Files edited

None. All nine verification items came back clean against HEAD; the only finding is a stale CLAUDE.md / resolver-header comment that is doc-only and tracked in BACKLOG.

## Test smoke

```
services/agent-claw  npx tsc --noEmit -p .          → ok
services/agent-claw  vitest tests/unit/permission-enforce-mode.test.ts → 4/4
services/agent-claw  vitest tests/unit/sub-agent.test.ts              → 10/10
services/agent-claw  vitest tests/unit/harness-loop.test.ts           → 12/12
services/agent-claw  vitest tests/unit/harness-seen-fact-ids.test.ts  → 3/3
services/agent-claw  vitest tests/unit/hook-loader.test.ts            → 10/10
```
