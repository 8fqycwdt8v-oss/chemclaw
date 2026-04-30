# Track A — TypeScript hotspots audit

Wave 1, read-only. No code modified. All citations are `file:line` against the audit worktree at `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit`.

Files in scope:

| File | LOC |
|---|---|
| `services/agent-claw/src/routes/chat.ts` | 975 |
| `services/agent-claw/src/routes/sessions.ts` | 758 |
| `services/agent-claw/src/index.ts` | 565 |
| `services/agent-claw/src/core/sandbox.ts` | 247 |
| `services/agent-claw/src/core/step.ts` | 382 |

The Wave 2 PR-6 split sketch in `~/.claude/plans/develop-an-intense-code-happy-feather.md:83-104` is the baseline. Boundaries proposed below refine that plan with line-level evidence; deviations are flagged.

---

## File: `services/agent-claw/src/routes/chat.ts` (975 LOC)

This is one route handler whose body is `handleChat` (`chat.ts:179-950`). The body weaves at least eight concerns into a single 770-line function, each of which is a candidate for a standalone module. The route registration (`registerChatRoute`, `chat.ts:956-975`) is a one-liner that runs the handler inside `runWithRequestContext`.

### Cohesion analysis

| # | Concern | Line range | # internal helpers | # imports it pulls in | Standalone-cohesive? |
|---|---|---|---|---|---|
| 1 | Zod request schema + dependency types | `chat.ts:89-126` | 0 | `zod`, `Pool`, `Config`, `LlmProvider`, `ToolRegistry`, `PromptRegistry`, `SkillLoader`, `PaperclipClient`, `ShadowEvaluator` | Yes — pure types, zero runtime. |
| 2 | History/length bounds enforcement | `chat.ts:132-153` (`enforceBounds`) | 1 | `Config` | Yes — already extracted into a free function; trivial to lift verbatim. |
| 3 | `/feedback` write helper | `chat.ts:159-173` (`writeFeedback`) | 1 | `withUserContext`, `Pool` | Yes — independent DB helper. |
| 4 | Slash-verb pre-pass + short-circuit responses | `chat.ts:202-286` | 0 (inlined) | `parseSlash`, `parseFeedbackArgs`, `shortCircuitResponse`, `HELP_TEXT`, `setupSse`, `writeEvent` | Yes — entirely SSE/text-completion emission with no harness invocation. The "short-circuit verb" path duplicates `setupSse` + 3-event finish 4 times (`chat.ts:218-226`, `236-243`, `255-263`, `277-284`). |
| 5 | System-prompt assembly (registry + skills + plan suffix) | `chat.ts:304-329` | 0 | `PromptRegistry`, `SkillLoader`, `PLAN_MODE_SYSTEM_SUFFIX` | Yes — pure string composition + one DB read. |
| 6 | Session resolution (load-or-create + clear awaiting + budget caps) | `chat.ts:340-404` | 0 (inlined) | `loadSession`, `saveSession`, `createSession`, `Config` | Yes — but **interleaves** Phase F session-budget cap reads with the pre-existing load/create logic. The cap-loading branch (`357-394`) and the create branch (`396-403`) read 8 different fields off the loaded session row that nothing else in the route consumes structurally. |
| 7 | Lifecycle dispatches (`user_prompt_submit`, `session_start`, manual `/compact`) | `chat.ts:418-477` | 0 | `lifecycle`, `estimateTokenCount`, `PreCompactPayload`, `PostCompactPayload` | Yes — three independent best-effort dispatches that share only `ctx`. |
| 8 | Tool filtering + agent build + Paperclip reservation | `chat.ts:479-521` | 0 | `buildAgent`, `PaperclipClient`, `ReservationHandle`, `PaperclipBudgetError`, `USD_PER_TOKEN_ESTIMATE` | Yes — but the reserve path duplicates the per-iteration reserve in `runChainedHarness` (`sessions.ts:514-530`). |
| 9 | Root-span open + non-streaming-close helper | `chat.ts:528-564` | 1 (`closeNonStreamingTurn`) | `startRootTurnSpan`, `recordLlmUsage`, `recordSpanError`, OpenTelemetry api | Yes — but the helper exists only because the non-streaming path's success and error returns each need to release Paperclip + close the span; the streaming path duplicates the same release/close inline at `chat.ts:907-928`. |
| 10 | Non-streaming branch (plan-mode JSON / agent.run / error) | `chat.ts:566-608` | 0 | `agent.run`, `completeJson`, `parsePlanSteps`, `createPlan`, `planStore`, `otelContext`, `trace` | Yes — this is the only place the non-streaming response shape is built. |
| 11 | SSE streaming preamble (setupSse, close listeners, redaction list, budget hoist) | `chat.ts:610-645` | 0 | `setupSse`, `Budget`, `RedactReplacement` | Yes — five hoisted state vars used by the try/catch/finally below. |
| 12 | Plan-mode SSE branch | `chat.ts:646-713` | 0 | `parsePlanSteps`, `createPlan`, `planStore`, `savePlanForSession`, `writeEvent` | Yes — fully self-contained alternate path. Almost a duplicate of the non-streaming plan branch at `chat.ts:570-593`. |
| 13 | Token-streaming harness invocation (sink build + budget + runHarness) | `chat.ts:732-770` | 0 | `makeSseSink`, `runHarness`, `Budget` | Yes — this is the core "happy path." 38 LOC. |
| 14 | Typed-error classifier (try/catch arms) | `chat.ts:771-810` | 0 | `SessionBudgetExceededError`, `BudgetExceededError`, `OptimisticLockError`, `AwaitingUserInputError` | Yes — pure pattern-match over the 4 typed errors plus generic. |
| 15 | Finally block: stream-redaction persistence, `persistTurnState`, `awaiting_user_input` emit, `session_end`, `finish` emit, span close, Paperclip release, shadow eval, skill cleanup, socket end | `chat.ts:811-949` | 0 | `RedactReplacement`, `persistTurnState`, `lifecycle`, `recordLlmUsage`, `recordSpanError`, `ShadowEvaluator`, `SessionFinishReason` | **Mixed.** Nine logically distinct end-of-turn duties run sequentially here. Each is independently testable; today none are. |
| 16 | Route registration + AsyncLocalStorage wrap | `chat.ts:956-975` | 0 | `runWithRequestContext` | Yes — trivial. |

**Two dominant patterns make this file hard to maintain.** First, the SSE-finish triple (`text_delta` + `finish` + `reply.raw.end()`) is repeated four times in the slash short-circuit at `chat.ts:218-226`, `236-243`, `255-263`, `277-284`, again in the plan-mode branches at `chat.ts:696-700` and `chat.ts:894-904`, and a seventh time as the implicit "no errors" path of the finally. Second, the streaming + non-streaming paths each carry their own copy of "close root span / release Paperclip / cleanup skill" — the helper `closeNonStreamingTurn` only handles the non-streaming half. Both are extractable.

### Proposed split

PR-6's sketch ([plan:86-91](file:///Users/robertmoeckel/.claude/plans/develop-an-intense-code-happy-feather.md)) is 4 files; the line-level evidence above suggests **5** is a cleaner cut. The extra file isolates short-circuit slash verbs, which today are 86 lines (`chat.ts:202-286`) of pre-harness flow that share zero state with the rest of the handler.

#### `services/agent-claw/src/routes/chat/index.ts` (target: ≤120 LOC)

Handler wiring + bounds + dependency type. Re-exports `StreamEvent` for back-compat with existing `import type { StreamEvent } from "./chat.js"` callers (today re-exported at `chat.ts:87`).

- Extract from `chat.ts:1-105` (header + imports + Zod schemas), `chat.ts:111-126` (`ChatRouteDeps`), `chat.ts:132-153` (`enforceBounds`), `chat.ts:179-198` (parse + bounds entry of `handleChat`), `chat.ts:956-975` (`registerChatRoute`).
- Public surface: `registerChatRoute(app, deps)`, `ChatRouteDeps`, re-export `StreamEvent`.
- Calls into the four sibling modules below.

#### `services/agent-claw/src/routes/chat/slash-shortcircuit.ts`

The pre-harness verbs that don't need the LLM. Zero coupling to session, harness, Paperclip, OTel.

- Extract from `chat.ts:202-286`.
- Bring along `writeFeedback` from `chat.ts:159-173`.
- Public surface: `tryHandleShortCircuitSlash(req, reply, body, slashResult, doStream, deps): Promise<boolean>` — returns `true` when the verb was handled (handler returns), `false` to fall through.
- Eliminates the 4× duplication of `setupSse + writeEvent(text_delta) + writeEvent(finish) + reply.raw.end()` by extracting a `sendStaticTextCompletion(reply, doStream, text)` private helper.

#### `services/agent-claw/src/routes/chat/session-resolution.ts`

PR-6 sketch calls this `session-resolution.ts`. Same name; expand to also build the system prompt + skill activation since both fire before any harness call.

- Extract from `chat.ts:289-444`: skill-activation gate (`295-302`), system prompt assembly (`304-329`), the `messages` array build (`331-338`), session load-or-create (`340-404`), `hydrateScratchpad` + ctx build (`406-416`), and the three pre-harness lifecycle dispatches (`418-477`).
- Public surface: `resolveTurnState(req, body, slashResult, deps): Promise<TurnState>` returning `{ ctx, messages, sessionId, sessionExisted, sessionEtag, sessionInputUsed, sessionOutputUsed, sessionStepsUsed, sessionInputCap, sessionOutputCap, systemPrompt, activePromptVersion, cleanupSkillForTurn, isPlanMode }`.
- Reuses `hydrateScratchpad` from `core/session-state.ts:59-80` (do **not** re-implement).
- Reuses `withUserContext` indirectly via `loadSession` / `saveSession` / `createSession` (do **not** re-implement).

#### `services/agent-claw/src/routes/chat/turn-orchestration.ts`

Both run paths: non-streaming `agent.run`, streaming `runHarness`, plan-mode JSON. Wraps Paperclip + root-span lifecycle and exposes a single dispatch function.

- Extract from `chat.ts:482-770`: tool filtering + agent build (`479-493`), Paperclip reserve (`495-521`), root-span open (`528-535`), `closeNonStreamingTurn` (`540-564`), the entire non-streaming branch (`566-608`), the SSE preamble (`610-645`), the plan-mode SSE branch (`646-713`), and the streaming harness invocation block (`732-770`).
- Public surface:
  - `runStreamingTurn(req, reply, state, deps): Promise<StreamingTurnResult>` returning `{ finishReason, budget, streamRedactions, paperclipHandle, rootSpan, closed }` so the finally module can read them.
  - `runNonStreamingTurn(req, reply, state, deps): Promise<void>` (writes the response and returns).
- Centralises the two separate Paperclip-reserve and span-close paths that today are duplicated between `chat.ts:498-521` / `chat.ts:540-564` / `chat.ts:907-928`.

#### `services/agent-claw/src/routes/chat/end-of-turn.ts`

The finally-block dance (≈140 LOC). PR-6 sketch put this inside `turn-orchestration.ts`; pulling it out makes the streaming-finish contract testable in isolation and forces the contract to be explicit (today it's a closure over 11 captured variables).

- Extract from `chat.ts:811-949`.
- Public surface: `finalizeStreamingTurn(reply, state, runResult, deps): Promise<void>`.
- Reuses `persistTurnState` from `core/session-state.ts:90-171` (do **not** re-implement — see "Critical reuse" below).
- Internally factors:
  - `persistStreamRedactions(ctx, replacements)` (lines `817-836`)
  - `persistTurnAndMaybeEmitAwaiting(reply, ...)` (lines `845-877`)
  - `dispatchSessionEndIfStop(...)` (lines `882-892`)
  - `emitFinalFinish(reply, finishReason, budget, closed)` (lines `894-904`)
  - `closeRootSpanWithUsage(rootSpan, budget, model)` (lines `906-917`)
  - `releasePaperclip(handle, budget, log)` (lines `919-928`)
  - `fireShadowEvalIfStop(deps, finishReason, ...)` (lines `930-941`)

The streaming and non-streaming paths today have duplicated Paperclip-release + span-close logic; once `releasePaperclip` and `closeRootSpanWithUsage` are extracted, both paths call the same helpers and the duplication collapses.

### `any`-cast inventory

`chat.ts` currently has **zero** `any` / `as any` / `as unknown as` casts in the file body. Two soft type-coercions exist via `delete` + bracket-typed casts at `chat.ts:735-736`:

```ts
delete (sink as { onAwaitingUserInput?: unknown }).onAwaitingUserInput;
delete (sink as { onFinish?: unknown }).onFinish;
```

These are not `any`-casts but they are a structural-typing escape hatch. **Safe to fix without API change** by giving `makeSseSink` an opt-out parameter — e.g. `makeSseSink(reply, redactions, sessionId, { omitCallbacks: ["onAwaitingUserInput", "onFinish"] })`. The route's reason for stripping (`chat.ts:715-731` comment) is that it owns the order of `awaiting_user_input` then `finish` events; once the sink builder accepts an opt-out, the cast disappears.

There are several `as` widenings that are fine and idiomatic:

- `chat.ts:194` `parsed.data` is already typed.
- `chat.ts:308` `active.template` flows from `PromptRegistry`.
- `chat.ts:334` `m.role as Message["role"]` — the Zod schema already constrains the union, so this cast is redundant; replace with structural narrowing or drop entirely (low priority, no behaviour change).
- `chat.ts:820-824` `as Array<{ scope: string; replacements: RedactReplacement[]; timestamp: string; }>` — reading from a `Map<string, unknown>` scratchpad. Should use a typed `getScratchpad<T>(ctx, key, default)` accessor if one exists; if not, this is the canonical use of a deliberate scratchpad cast.

### Dead branches

- `chat.ts:213` — the unknown-verb gate `if (!["help", "skills", "feedback", "check", "learn"].includes(verb))` is reachable only when `slashResult.isStreamable === false`. Inspecting `parseSlash` (out of scope here, but visible via `chat.ts:39-43`) shows that the only verbs returning `isStreamable=false` are exactly that set plus possibly `compact` and `plan`. Since `compact` and `plan` are handled later (`chat.ts:289` for plan, `chat.ts:452` for compact) **on the streamable branch**, the `slashResult.verb !== ""` short-circuit at `chat.ts:209` only fires for one of the five known verbs — meaning the unknown-verb arm at `chat.ts:213-227` is **likely unreachable** today, but it's a defensive guard for future verb additions. Recommend keeping but documenting; or move the verb-allowlist into `parseSlash` so `isStreamable=false ⟹ verb ∈ allowlist` becomes a type-level guarantee.
- `chat.ts:367-371` — comment "Output budget defaults to 1/5 of input cap unless overridden via env. (Per-session override of the output cap is a follow-up.)" The branch reads `loaded.sessionTokenBudget` for the input cap but never updates `sessionOutputCap`. Not dead, but a documented partial-implementation that should resolve as part of PR-4 / PR-5 cleanup.
- `chat.ts:632-637` — the `TODO(disconnect-mid-stream)` block. PR-3 (referenced at `~/.claude/plans/develop-an-intense-code-happy-feather.md:60`) is scoped to fix exactly this. Keep flagged; not dead, just a known gap.
- `chat.ts:722-726` — comment claims "the harness's onFinish is a no-op when the sink omits the callback." Reading `streaming/sse-sink.ts:74-` confirms `onFinish` is set unconditionally by `makeSseSink`, then deleted at `chat.ts:736`. The branch is alive; the comment is the contract. After the proposed `omitCallbacks` API change, the explanatory comment moves with it.

### Breaking-change risk (public HTTP API surface)

| Surface | Location | Notes |
|---|---|---|
| `POST /api/chat` route signature (Zod-validated body) | `chat.ts:89-103`, `chat.ts:957-958` | Public. Any change to `messages`, `stream`, `agent_trace_id`, `session_id` is a wire break. The proposed split must preserve `ChatRequestSchema` verbatim. |
| SSE event names | `chat.ts:219`, `247`, `268`, `661`, `691`, `697`, `707`, `779`, `790`, `796`, `808`, `865`, `896`, `899` | The wire union is `{type: "text_delta" \| "finish" \| "error" \| "plan_step" \| "plan_ready" \| "awaiting_user_input"}`. **Public.** Changes break clients. |
| Header contract: `x-user-entra-id` (read inside `getUser` via `deps.getUser`) | `chat.ts:184` reads via injected `getUser`; the actual extraction lives in `index.ts:282-293` | Public. Auth-proxy contract. |
| Error response shapes | `chat.ts:188-191`, `chat.ts:197`, `chat.ts:266`, `chat.ts:512-517`, `chat.ts:606` | Public envelope: `{error: <code>, ...}`. Codes used: `invalid_input`, `history_too_long`, `message_too_long`, `internal`, `feedback_write_failed`, `budget_exceeded` (HTTP), and SSE-error codes `session_budget_exceeded` / `budget_exceeded` / `concurrent_modification` / `plan_mode_failed`. |
| 429 + `Retry-After` header on Paperclip refusal | `chat.ts:511-517` | Public quota signal. |
| `session` SSE event schema | emitted via the sink at `chat.ts:732` (`makeSseSink`); contract documented at `chat.ts:613-615` | Public. The route comment notes "we do NOT emit it here directly — that would double-fire." That contract must be preserved across the split. |
| Re-exported `StreamEvent` type | `chat.ts:87` (`export type { StreamEvent } from "../streaming/sse.js"`) | Internal-public; tests import from `./chat.js`. The new `routes/chat/index.ts` must keep the same re-export path. |

### Critical reuse opportunities

| Already-existing helper | Re-implementation in `chat.ts` | Recommendation |
|---|---|---|
| `withUserContext(pool, user, fn)` (`db/with-user-context.ts:17-44`) | Used correctly via `writeFeedback` (`chat.ts:166`). Indirectly via `loadSession` / `saveSession` / `createSession` (which call it internally). | No re-implementation. Keep. |
| `hydrateScratchpad(prior, sessionId, tokenBudget)` (`core/session-state.ts:59-80`) | Used at `chat.ts:406-410`. | Already reused. The PR-6 split must continue to import from `core/session-state.ts`. |
| `persistTurnState(pool, user, sessionId, ctx, budget, finishReason, opts)` (`core/session-state.ts:90-171`) | Used at `chat.ts:847-859`. | Already reused. Same recommendation. |
| `redactString(s, replacements)` (`core/hooks/redact-secrets.ts`) | Imported at `chat.ts:44`; the route uses it indirectly via `makeSseSink`'s `onTextDelta` and `persistTurnState`'s `redactString` call (`session-state.ts:127`). | Already reused. The streaming-redactions array (`chat.ts:638`) flows from `makeSseSink` (`streaming/sse-sink.ts`); the array is then attached to scratchpad at `chat.ts:817-835` — that 18-line block is its own near-duplicate of the persistence path inside `persistTurnState`. Consider moving `_streamRedactions` persistence into `persistTurnState` (extend its signature with `priorStreamRedactions?: RedactReplacement[]`) so the route just hands them off. |
| `lifecycle` singleton (`core/runtime.ts`) | Imported at `chat.ts:47`. Used at lines 415, 425, 436, 463, 471, 884. | Already reused. |
| `loadHooks` / `BUILTIN_REGISTRARS` (`core/hook-loader.ts:94-124`) | Not used in `chat.ts` directly — the route just dispatches into the singleton lifecycle that `loadHooks` populated at boot. | Correct; no action. |

### Non-cohesion finding worth a separate PR-5 entry

The two near-duplicate plan-mode bodies — non-streaming at `chat.ts:570-593` and SSE at `chat.ts:646-712` — both call `completeJson`, `parsePlanSteps`, `createPlan`, `planStore.save`, and (in the SSE path) `savePlanForSession`. Between them they re-implement the same plan-emission logic. Neither path persists to `agent_plans` in the non-streaming branch (the SSE path does, the JSON path does not — see `chat.ts:681-687` vs the non-streaming branch). That's a latent functional divergence: a non-streaming plan request leaves no DB-backed plan, so `/api/sessions/:id/plan/run` cannot find it later. Recommend either (a) consolidating both into a single `runPlanModeTurn(...)` helper that always persists, or (b) explicitly documenting that non-streaming plan-mode is in-memory-only.

---

## File: `services/agent-claw/src/routes/sessions.ts` (758 LOC)

Three GET endpoints + three POST endpoints + one exported helper (`runChainedHarness`). Of the file's 758 lines, **291 (`sessions.ts:463-753`)** are the chained-harness implementation — that's a third of the file and is itself the single biggest function in the agent-claw service after `handleChat`.

### Cohesion analysis

| # | Concern | Line range | # internal helpers | # imports it pulls in | Standalone-cohesive? |
|---|---|---|---|---|---|
| 1 | Route deps + per-route rate-limit wiring | `sessions.ts:48-82` | 0 | `Config` | Yes — pure config plumbing. |
| 2 | `GET /api/sessions/:id` (status read) | `sessions.ts:86-110` | 0 | `loadSession` | Yes — pure read with one DB hit. |
| 3 | `GET /api/sessions` (list) | `sessions.ts:116-155` | 0 | `withUserContext` | Yes — single SELECT + map. |
| 4 | `POST /api/sessions/:id/plan/run` (chained execute) | `sessions.ts:165-237` | 0 | `loadActivePlanForSession`, `advancePlan`, `runChainedHarness` | Yes — orchestrator over the helper. |
| 5 | `POST /api/sessions/:id/resume` (auto-resume, header-trust) | `sessions.ts:255-323` | 0 | `loadSession`, `tryIncrementAutoResumeCount`, `runChainedHarness` | Yes. |
| 6 | `POST /api/internal/sessions/:id/resume` (JWT-trust resume) | `sessions.ts:338-417` | 0 | `verifyBearerHeader`, `McpAuthError`, `loadSession`, `tryIncrementAutoResumeCount`, `runChainedHarness` | Yes — but lines 376-417 are a **near-verbatim duplicate** of lines 278-322 with only the user-source swapped. |
| 7 | `runChainedHarness` public entrypoint (AsyncLocalStorage wrap) | `sessions.ts:463-473` | 1 | `runWithRequestContext` | Yes — 11 LOC. |
| 8 | `_runChainedHarnessInner` — main loop | `sessions.ts:475-696` | 0 (inlined) | `Budget`, `runHarness`, `hydrateScratchpad`, `persistTurnState`, `lifecycle`, `Paperclip*`, error classes | **No** — interleaves Paperclip reservation lifecycle, scratchpad hydrate, lifecycle dispatches, runHarness, plan-progress walker, persist, error classification, and continue-message rebuild. 222 LOC, single while-loop. |
| 9 | session_end dispatch at chain end | `sessions.ts:698-745` | 0 | `loadSession`, `lifecycle` | Yes — independent block; reloads session to populate `endCtx`. |

### Proposed split

PR-6 sketch ([plan:92-95](file:///Users/robertmoeckel/.claude/plans/develop-an-intense-code-happy-feather.md)) is 3 files; line-level evidence supports refining to **4** so the chained-harness helper has its own home. Routes are thin orchestrators; the 222-line loop deserves a focused module.

#### `services/agent-claw/src/routes/sessions/index.ts`

Wires the route registrations + holds `SessionsRouteDeps` + the per-route rate-limit object. Reads endpoints (GET-by-id and GET-list) live here because they're each ~30 LOC.

- Extract from `sessions.ts:1-82` (header, imports, `SessionsRouteDeps`, `sessionMutatingRateLimit`), `sessions.ts:86-155` (the two GETs), `sessions.ts:165-237` / `sessions.ts:255-323` / `sessions.ts:338-417` (route handlers — but each delegates the body to the modules below).
- Public surface: `registerSessionsRoute(app, deps)`.

#### `services/agent-claw/src/routes/sessions/plan-handlers.ts`

The plan/run POST. Owns mapping from `runChainedHarness` result → `advancePlan` status transitions.

- Extract from `sessions.ts:165-237` (the route body). Wrap as `handlePlanRun(req, reply, deps): Promise<void>`.
- Public surface: `handlePlanRun(req, reply, deps)`.

#### `services/agent-claw/src/routes/sessions/resume-handlers.ts`

Both resume POSTs. The two handlers share **all** of the post-`tryIncrementAutoResumeCount` logic; today the duplication is at `sessions.ts:278-322` vs `sessions.ts:376-417`. Extract a private helper.

- Extract from `sessions.ts:255-323` and `sessions.ts:338-417`.
- Public surface: `handleResume(req, reply, deps)` (header-trust) and `handleInternalResume(req, reply, deps)` (JWT-trust).
- Private `_runResumeForUser(req, reply, sessionId, user, deps)` consolidates the post-increment 39-line duplicate.
- Reuses `verifyBearerHeader` from `security/mcp-tokens.ts:116-132` (do **not** re-implement).

#### `services/agent-claw/src/core/chained-harness.ts`

The 291-line helper that today lives at the bottom of `routes/sessions.ts` deserves its own module — it's the only piece of multi-turn agent orchestration outside `runHarness`, and at least one integration test (`sessions.ts:425-427` comment cites `tests/integration/chained-execution.test.ts`) imports it. Moving it to `core/` makes that boundary explicit and tracks the harness layer it sits beside.

- Extract from `sessions.ts:431-461` (interfaces) and `sessions.ts:463-753` (implementation).
- Public surface: `runChainedHarness(opts): Promise<ChainedHarnessResult>`, `ChainedHarnessOptions`, `ChainedHarnessResult`.
- Internally factor the 222-line loop into:
  - `_reservePaperclipForIteration(opts, sessionId, user, log)` (lines `514-530`)
  - `_runOneChainedIteration(state, ctx, opts)` (lines `541-660`)
  - `_classifyChainError(err, log)` (lines `661-695`)
  - `_dispatchSessionEnd(opts, sessionId, user, log)` (lines `698-745`) — already a self-contained block today.

### `any`-cast inventory

`sessions.ts` has **zero** `any` / `as any` casts. One `as` cast exists:

- `sessions.ts:21` — `type SessionFinishReason` re-export. Type-only, not a runtime cast. Safe.

The file is type-clean. Recommend the split preserve the existing strictness.

### Dead branches

- `sessions.ts:380-391` — the `claimedUser` branch returns `404 not_found` if the session row is missing. The JWT-only-trust contract (`sessions.ts:332-336`) means that the only way `loadSession` returns `null` after `tryIncrementAutoResumeCount` returned `null` is "concurrent delete" or "wrong user in claims". The first is rare; the second is exactly the failure mode the JWT contract is supposed to prevent. Not dead, but worth an explicit log so a misconfigured signing-key swap surfaces here rather than silently 404'ing.
- `sessions.ts:520` — `estTokens: 12_000` and `estUsd: 0.05` are duplicated from `chat.ts:504-506`. Not dead but a magic-number duplication; PR-5 cleanup or a shared `PAPERCLIP_RESERVATION_DEFAULTS` constant.
- `sessions.ts:710` — `if (sessionStartFired && finalFinishReason === "stop")` — the `sessionStartFired` part is always true on the dispatch path because `sessionStartFired` is only ever set to `true` (sessions.ts:552) and the only path that reaches `sessions.ts:710` with `false` is when the chain exits before the first iteration successfully runs `loadSession`. That exit path sets `finalFinishReason = "session_lost"` (sessions.ts:506), so the `=== "stop"` arm filters it. The `sessionStartFired` term is therefore redundant; readability fix only.

### Breaking-change risk (public HTTP API surface)

| Surface | Location | Notes |
|---|---|---|
| `GET /api/sessions/:id` response shape | `sessions.ts:96-109` | Public. Includes `session_id`, `todos[]`, `awaiting_question`, `last_finish_reason`, `message_count`, `created_at`, `updated_at`. |
| `GET /api/sessions` (list) response shape + `?limit` query | `sessions.ts:116-155` | Public. The clamp `min(100, max(1, limit))` is part of the contract. |
| `POST /api/sessions/:id/plan/run` request (no body) + response | `sessions.ts:165`, `sessions.ts:225-236` | Public. Returns `plan_id`, `session_id`, `auto_turns_used`, `final_finish_reason`, `total_steps_used`, `plan_progress.{current_step_index,total_steps}`. |
| `POST /api/sessions/:id/resume` response | `sessions.ts:317-322` | Public. Returns `session_id`, `final_finish_reason`, `total_steps_used`, `auto_resume_count`. |
| `POST /api/internal/sessions/:id/resume` JWT contract | `sessions.ts:347-368` | Public-internal. Bearer with `agent:resume` scope; `claims.user` is trusted, NOT `x-user-entra-id`. **Critical contract** — the split must preserve "header is read from claims, not from `getUser(req)`." |
| Error envelope codes | `sessions.ts:90`, `94`, `167`, `175`, `180`, `255`, `265`, `269`, `283`, `286`, `293`, `354`, `362`, `381`, `385`, `388` | Public codes: `invalid_input`, `not_found`, `harness_deps_missing`, `no_active_plan`, `awaiting_user_input` (409), `auto_resume_cap_reached` (409), `unauthenticated` (401). |
| Per-route rate-limit (1/4 of chat limit) | `sessions.ts:73-82` | Soft-public (visible via 429 responses). |
| Exported helper `runChainedHarness` | `sessions.ts:463-473` | Tests in `tests/integration/chained-execution.test.ts` import it. The proposed move to `core/chained-harness.ts` is a code-relocation only — re-export from `routes/sessions/index.ts` for back-compat, OR update the tests in the same PR. |

### Critical reuse opportunities

| Already-existing helper | Re-implementation in `sessions.ts` | Recommendation |
|---|---|---|
| `withUserContext` (`db/with-user-context.ts:17-44`) | Used at `sessions.ts:121` for the SELECT in the list endpoint. | Already reused. |
| `hydrateScratchpad` (`core/session-state.ts:59-80`) | Used at `sessions.ts:541-545` and at `sessions.ts:716-722`. | Already reused. |
| `persistTurnState` (`core/session-state.ts:90-171`) | Used at `sessions.ts:613-625`. | Already reused. The comment at `sessions.ts:606-612` ("The previous inline dump bypassed redaction") confirms a prior near-duplicate was already collapsed into the shared helper. |
| `verifyBearerHeader` (`security/mcp-tokens.ts:116-132`) | Used at `sessions.ts:350-359`. | Already reused. |
| `runWithRequestContext` (`core/request-context.ts`) | Used at `sessions.ts:469-472`. | Already reused. |
| `runHarness` (`core/harness.ts`) | Used at `sessions.ts:576-583`. | Already reused. |
| Per-iteration Paperclip reserve/release | The reserve at `sessions.ts:514-530` and release at `sessions.ts:636-645` and the catch-path release at `sessions.ts:665-672` together near-duplicate `chat.ts:498-521` + `chat.ts:919-928` + `chat.ts:555-563`. | **Not currently reused.** Extract a `withPaperclipReservation(opts, fn)` helper in `core/paperclip-client.ts` (or a new `core/paperclip-lease.ts`) that handles reserve → run → release-on-success → release-on-error — consolidating four call sites. PR-5 candidate. |
| Continue-message constant `"Continue with the next step on your todo list..."` | `sessions.ts:301`, `sessions.ts:395` (verbatim duplicate). | Extract `RESUME_CONTINUE_PROMPT` constant. |
| Continue-message constant inside the chain `"Continue from the last step. Stop when the plan is complete."` | `sessions.ts:652`. | Extract alongside the above. |

---

## File: `services/agent-claw/src/index.ts` (565 LOC, 54 internal imports)

### Cohesion analysis

This is the service entrypoint. It does **eight** distinct things in a single top-level module that runs at import time.

| # | Concern | Line range | Standalone-cohesive? |
|---|---|---|---|
| 1 | Imports (54 internal) | `index.ts:12-74` | The volume itself is the smell — a single module shouldn't need 54 internal imports. Almost all are tool-builder factories that immediately get registered into `ToolRegistry`. |
| 2 | OTel tracer init | `index.ts:80-86` | Yes — single call. |
| 3 | Fastify + helmet + cors + rate-limit setup | `index.ts:90-143` | Yes — coherent middleware block. |
| 4 | DI container construction (pool, llm, registry, prompt registry, skill loader, paperclip, shadow evaluator) | `index.ts:149-169` | Yes — one logical "build deps" step. |
| 5 | Tool-registry hydration (29 `registerBuiltin` calls + commentary) | `index.ts:171-258` | Yes — but it's 88 LOC and grows by one line per tool. Best abstracted into a `registerAllBuiltins(registry, deps)` function in a new `bootstrap/tools.ts`. |
| 6 | Auth header handling (`getUser` + `MissingUserError` + global error handler) | `index.ts:264-313` | Yes — 50 LOC fully isolatable. |
| 7 | Route registration | `index.ts:315-368` | Yes — `routeDeps` object built once, passed to 9 route registrars. |
| 8 | `/readyz` probe (Postgres + mcp_tools health) | `index.ts:370-397` | Yes — also touches `pool` directly. |
| 9 | mcp_tools health-probe loop | `index.ts:411-455` | Yes — fully self-contained background loop. |
| 10 | Startup sequence (registry hydrate → loadHooks → skillLoader.load → app.listen → probe loop) | `index.ts:461-534` | Yes — `start()` is already extracted; just lives at the bottom of this file. |
| 11 | Shutdown + global error handlers (SIGINT, SIGTERM, unhandledRejection, uncaughtException) | `index.ts:536-563` | Yes. |

### Proposed split

PR-6 sketch ([plan:96-101](file:///Users/robertmoeckel/.claude/plans/develop-an-intense-code-happy-feather.md)) is 5 files. Line-level evidence supports the split exactly as written, with one refinement: tool registration (concern 5 above) deserves its own file because `index.ts:171-258` is 88 LOC of repetitive `registerBuiltin` calls and is the second-most-volatile block in `index.ts` (one line per new tool). Also, the entrypoint shrinks below the ≤40 LOC PR-6 target only when this is extracted.

#### `services/agent-claw/src/index.ts` (target: ≤40 LOC)

- Imports: `loadConfig`, `bootstrap/server`, `bootstrap/lifecycle`, `bootstrap/probes`, `bootstrap/db`, `bootstrap/tools`, `bootstrap/auth`, OTel init.
- Body: load config, init OTel, build deps, register middleware, register routes, register probe routes, start server, install shutdown handlers.
- Re-export: `pool`, `registry`, `llmProvider`, `promptRegistry`, `lifecycle`, `skillLoader`, `probeMcpTools` (currently exported at `index.ts:455` for tests — must preserve).

#### `services/agent-claw/src/bootstrap/db.ts`

- Extract from `index.ts:149` (`pool = createPool(cfg)`).
- Public surface: `buildDb(cfg): { pool: Pool }`. The PR-6 sketch's "role grants check" is forward-looking; today there's no role-grants check in `index.ts`, so document as a TODO for PR-8 verification.

#### `services/agent-claw/src/bootstrap/lifecycle.ts`

- Extract from `index.ts:484-503` (the `loadHooks` call + `MIN_EXPECTED_HOOKS` assertion).
- Public surface: `loadAndAssertHooks(lifecycle, deps): Promise<HookLoadResult>`.
- Reuses `loadHooks` from `core/hook-loader.ts:146-250` (do **not** re-implement).
- The `MIN_EXPECTED_HOOKS = 11` constant is currently inline at `index.ts:484`; should move with the helper. CLAUDE.md (in the project doc) calls out keeping this in sync as the source-of-truth for hook count parity.

#### `services/agent-claw/src/bootstrap/probes.ts`

- Extract from `index.ts:264` (`registerHealthzRoute`), `index.ts:370-397` (`/readyz` handler), `index.ts:411-452` (`probeMcpTools` + interval loop).
- Public surface: `registerProbeRoutes(app, deps)`, `startMcpProbeLoop(app, pool, intervalMs?)`, `probeMcpTools(app, pool)` (test-exported).
- The PR-6 sketch mentions adding `/version`; today there's no `/version` endpoint in `index.ts`. Adding it is in scope of this module if PR-6 includes it.

#### `services/agent-claw/src/bootstrap/server.ts`

- Extract from `index.ts:90-143` (Fastify + helmet + cors + rate-limit) and `index.ts:264-313` (auth + error handler).
- Public surface: `buildServer(cfg): Promise<FastifyInstance>`, `MissingUserError`, `makeGetUser(cfg)`.
- The PR-6 sketch puts auth in `bootstrap/server.ts`; consider a separate `bootstrap/auth.ts` since `getUser` + `MissingUserError` + the error handler form a self-contained 50-LOC unit testable in isolation. Either is fine; the call is whether the auth surface deserves a dedicated module.

#### `services/agent-claw/src/bootstrap/tools.ts`

- Extract from `index.ts:171-258` (the 88-line block of `registerBuiltin` calls).
- Public surface: `registerAllBuiltins(registry, deps): void`.
- The `asTool = (t: unknown) => t as ToolBuiltin` helper at `index.ts:174` moves with this module.

### `any`-cast inventory

Several `as` casts that are not `any` but worth flagging:

- `index.ts:174` — `const asTool = (t: unknown) => t as ToolBuiltin;` This is the "covariant Tool<unknown,unknown>" workaround. **Cannot be safely fixed without an API change.** The `ToolRegistry.registerBuiltin` signature should take `Tool<unknown, unknown>` directly so individual builders can register without the cast. PR-4 candidate. Replacement type: `Tool<unknown, unknown>`.
- `index.ts:308` — `const e = err as { statusCode?: number; message?: string };` Defensive narrowing of `unknown` to read Fastify error shape. **Safe to fix without API change** — the proper type is `import('fastify').FastifyError`. Replacement: `err as FastifyError`.
- `index.ts:324`, `332`, `336`, `337`, `341`, `351`, `355`, `359` — `getUser as (req: import("fastify").FastifyRequest) => string`. The `getUser` const is typed as `(req: { headers: Record<string, string | string[] | undefined> }) => string` (the structural shape it actually needs); each route registrar wants a `FastifyRequest`. **Safe to fix without API change** by typing `getUser` as `(req: FastifyRequest) => string` from the start. Replacement: change the `getUser` definition at `index.ts:282` to accept `FastifyRequest`. Eliminates 8 cast sites.

The above 8 casts are noise — the actual callers don't need the broader structural type. PR-4 is the obvious place to fix these.

### Dead branches

- `index.ts:243-244` — comment "LIMS adapters remain unwired in this build." Not dead code, but **dead documentation** flagging an architectural placeholder. Keep as-is or move to ADR.
- `index.ts:246-250` — comment "forge_tool, run_program, induce_forged_tool_from_trace, dispatch_sub_agent, add_forged_tool_test are intentionally NOT registered here." Documents an explicit absence; the imports for these tools don't exist in `index.ts:12-74` either, so the comment is canonically describing what is correctly absent. Keep.
- `index.ts:480-484` — comment about `MIN_EXPECTED_HOOKS = 11`. The CLAUDE.md hooks table lists 11 entries (see project doc). On the audit branch I count 11 entries in `BUILTIN_REGISTRARS` (`core/hook-loader.ts:94-124`): `redact-secrets`, `tag-maturity`, `budget-guard`, `init-scratch`, `anti-fabrication`, `foundation-citation-guard`, `source-cache`, `compact-window`, `apply-skills`, `session-events`, `permission`. **Matches.** Not dead.
- `index.ts:524-529` — the probe-loop schedule. The first probe starts after a 60s delay (`setTimeout(..., MCP_HEALTH_PROBE_INTERVAL_MS)` at `index.ts:529`), which means right after startup `/readyz` will return `no_healthy_mcp_tools` for up to 60 seconds. This is a **latent functional bug**, not dead code: the comment at `index.ts:404-405` claims the loop "ensures /readyz has fresh data" but the first run is delayed. Recommend running `await probeMcpTools()` once before the interval kicks in, or schedule with `setTimeout(..., 0)` for the first iteration. Worth flagging in PR-3 / PR-5.

### Breaking-change risk (public HTTP API surface)

| Surface | Location | Notes |
|---|---|---|
| `GET /healthz` | `index.ts:264` (registers via `registerHealthzRoute`) | Public liveness probe. |
| `GET /readyz` shape | `index.ts:376`, `386`, `393`, `397` | Public. Returns `{status: "ready"}` (200) or `{status: "not_ready", reason: <code>}` (503) with codes `postgres_unreachable`, `no_healthy_mcp_tools`, `mcp_tools_query_failed`. |
| Bind host/port | `index.ts:87-88`, `521` | Public via env. |
| CORS allowlist parse | `index.ts:119-121` | Public via env. |
| Header `x-user-entra-id` (or dev `x-dev-user-entra-id`) | `index.ts:282-293` | **Critical** auth-proxy contract. |
| Rate-limit key generator | `index.ts:136-140` | Soft-public (observable via 429 keys). |
| Error response envelope `{error, detail?}` for 401 / 500 | `index.ts:298-303`, `307-312` | Public. |
| Module re-exports for tests | `index.ts:455` | `pool`, `registry`, `llmProvider`, `promptRegistry`, `lifecycle`, `skillLoader`, `probeMcpTools` are imported by tests. The split must preserve these names from the new `index.ts`. |

### Critical reuse opportunities

| Already-existing helper | Re-implementation in `index.ts` | Recommendation |
|---|---|---|
| `loadHooks` (`core/hook-loader.ts:146-250`) | Used at `index.ts:486`. | Already reused. The only registration path on the production startup path; CLAUDE.md (project doc) explicitly notes this. |
| `lifecycle` singleton (`core/runtime.ts`) | Imported at `index.ts:71`, passed through `routeDeps` and `loadHooks`. | Already reused. |
| No `withUserContext` use in `index.ts` (correct — startup code doesn't run inside an RLS scope). | n/a | Correct as-is. |

The real reuse story for `index.ts` is the **opposite**: the file does too much itself. PR-6 splits the seven concerns into separate `bootstrap/*` modules; that's the lever, not adding more shared helpers.

---

## File: `services/agent-claw/src/core/sandbox.ts` (247 LOC)

### Cohesion analysis

| # | Concern | Line range | Cohesive? |
|---|---|---|---|
| 1 | Public types (`SandboxHandle`, `ExecutionResult`) | `sandbox.ts:14-30` | Yes. |
| 2 | `SandboxError` class | `sandbox.ts:36-44` | Yes. |
| 3 | Per-execution cap constants from env (CPU/MEM/NET) | `sandbox.ts:50-58` | Yes — but reads `process.env` directly. CHEMCLAW pattern in `config.ts` is to centralise env reads. |
| 4 | E2B SDK lazy loader (dynamic import + cache) | `sandbox.ts:63-107` | Yes — fully isolated. |
| 5 | `SandboxClient` interface | `sandbox.ts:113-125` | Yes. |
| 6 | `buildSandboxClient` factory (real E2B impl) | `sandbox.ts:132-247` | Yes — all four methods (`createSandbox`, `executePython`, `installPackages`, `mountReadOnlyFile`, `closeSandbox`) cluster around the lazy SDK loader. |

This file is already cohesive — at 247 LOC it doesn't merit a split. The interesting issue is the `any` surface around the E2B SDK boundary.

### `any`-cast inventory

The audit brief lists "6× `any`-casts." I count 6 explicit `any` annotations in 3 disabled-eslint pragmas at `sandbox.ts:93-98`:

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _importer: (spec: string) => Promise<any> = (s) => import(/* @vite-ignore */ s);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
const mod: any = await _importer("e2b");
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
const sdk: any = mod.Sandbox ?? mod.default;
```

| Site | Current type | Should be | Safe to fix without API change? |
|---|---|---|---|
| `sandbox.ts:94` | `Promise<any>` (return of dynamic import) | `Promise<unknown>` | **Yes** — the consumer below (`mod`) does its own narrowing. |
| `sandbox.ts:96` | `mod: any` | `mod: unknown` (then narrow) or `mod: { Sandbox?: unknown; default?: unknown }` | **Yes**, with a runtime type-guard added below. |
| `sandbox.ts:98` | `sdk: any` | `sdk: E2BSdkSandbox` after the `if (!sdk \|\| typeof sdk.create !== "function")` guard at `sandbox.ts:99` already narrows it. The cast at `sandbox.ts:102` (`sdk as E2BSdkSandbox`) is the actual type assertion; combining the guard with a custom type predicate would eliminate the `any`. | **Yes** — replace with a `function isE2BSdkSandbox(x: unknown): x is E2BSdkSandbox` predicate. |

Two further `as` casts not in the audit count but worth listing:

- `sandbox.ts:102` — `sdk as E2BSdkSandbox`. Once the predicate fix above lands, this becomes a typed narrowing rather than a cast.
- `sandbox.ts:105` — `(err as Error).message`. Defensive Error narrowing; idiomatic.
- `sandbox.ts:147` — `(err as Error).message`.
- `sandbox.ts:159` — `handle._raw as E2BSandboxInstance`. **Cannot be safely fixed without API change**: `SandboxHandle._raw: unknown` (defined at `sandbox.ts:20`) deliberately erases the type to keep callers from depending on the SDK shape. Replacement would require making `SandboxHandle` generic (`SandboxHandle<TRaw = unknown>`), which is a public interface change.
- `sandbox.ts:167`, `185`, `211`, `223`, `228`, `233`, `241`, `243` — all are `(err as Error).message` reads inside catches. Idiomatic.

### Dead branches

- `sandbox.ts:53-58` — `SANDBOX_MAX_NET_EGRESS` is read as a migration fallback. Comment says "the original (misleading)... is read as a migration fallback so existing deployments don't silently change behavior." Not dead, but a documented temporary; should have a target removal date or PR-5 cleanup task.
- `sandbox.ts:174-175` — `envs["CHEMCLAW_NO_NET"] = "1"` is set when `!SANDBOX_ALLOW_NET_EGRESS`, with the comment "advisory — actual blocking is enforced at E2B template level." This is **theatre code** if the E2B template doesn't actually read it. Verify: does the E2B template at `cfg.E2B_TEMPLATE_ID` honour `CHEMCLAW_NO_NET`? If not, delete the line. Worth a Wave 1 cross-check.
- `sandbox.ts:189-198` — file-listing best-effort with `try { ... } catch { filesCreated = []; }`. The empty-catch `// Non-fatal — execution result is still valid.` is fine. Not dead.
- `sandbox.ts:241-244` — `closeSandbox` swallows kill failures via `console.warn` only. PR-2 (logging unification, [plan:51](file:///Users/robertmoeckel/.claude/plans/develop-an-intense-code-happy-feather.md)) targets `core/step.ts:166`; the same `console.warn` pattern here at `sandbox.ts:243` should also migrate to Pino.

### Breaking-change risk

This file is internal-only (no HTTP routes). The public surface is the TypeScript API:

- `SandboxClient` interface (`sandbox.ts:113-125`)
- `SandboxHandle`, `ExecutionResult`, `SandboxError` types (`sandbox.ts:14-44`)
- `buildSandboxClient(cfg)` factory (`sandbox.ts:132`)
- The four env-var consts at `sandbox.ts:50-58` are imported elsewhere (verify via callers).

PR-4 type-tightening should not change any of these signatures.

### Critical reuse opportunities

- No use of `withUserContext`, `session-state`, `hook-loader`, or `mcp-tokens` in this file — correct. Sandbox layer is below the agent / route layer.
- The env-reads at `sandbox.ts:50-58` (`process.env["SANDBOX_MAX_CPU_S"]` etc.) bypass the central `loadConfig()` in `config.ts`. Recommendation: move these into `Config` and inject through `buildSandboxClient(cfg)`. **PR-5 / PR-4 candidate.** This is the same pattern PR-2 applies to logging.

---

## File: `services/agent-claw/src/core/step.ts` (382 LOC)

### Cohesion analysis

| # | Concern | Line range | Cohesive? |
|---|---|---|---|
| 1 | File header + imports | `step.ts:1-29` | Yes. |
| 2 | Public option/result types (`StepOnceOptions`, `StepToolOutput`, `StepOnceResult`) | `step.ts:31-71` | Yes. |
| 3 | `_runOneTool` — single-tool execution unit (permissions → pre_tool → validate → execute → validate → post_tool → sink) | `step.ts:81-246` | Yes — this is the per-tool body factored out for batch reuse. 165 LOC. |
| 4 | `stepOnce` — LLM call → text-stream OR tool-call(s) batch | `step.ts:263-382` | Yes. |

This file is already well-factored: `_runOneTool` is the per-tool primitive, `stepOnce` is the orchestrator. **No further splitting needed.** The 5 `any`-casts in the audit brief are the lever here.

### `any`-cast inventory

Searching the file body for `any` / `as any` / `as unknown as`:

| Site | Code | Should be | Safe to fix without API change? |
|---|---|---|---|
| `step.ts:238-239` | `(effectiveOutput as { todos: unknown }).todos` and `(effectiveOutput as { todos: TodoSnapshot[] }).todos` | A typed schema for `manage_todos` output: `ManageTodosOutput { todos: TodoSnapshot[] }` exported by `tools/builtins/manage_todos.ts`. Then: `if (toolId === "manage_todos" && isManageTodosOutput(effectiveOutput)) { streamSink.onTodoUpdate(effectiveOutput.todos); }`. | **Yes** — the manage_todos builder owns its output Zod schema; expose the inferred type. |
| `step.ts:60` (`output: unknown`) | `unknown` is the right type for a heterogeneous tool output. | n/a | n/a — already correct. |
| `step.ts:142`, `step.ts:219` | `prePayload`, `postPayload` typed structurally | already correct | n/a |

I do not see 5 `any` casts in `step.ts` body — I count 0 explicit `any` and 1 multi-cast pattern (`as { todos: unknown }` then `as { todos: TodoSnapshot[] }`). The audit brief's count of 5 may be counting `as` widenings broadly. Listing all `as` sites:

| Line | Cast | Analysis |
|---|---|---|
| `step.ts:209` | `err instanceof Error ? err : new Error(String(err))` | Idiomatic error narrowing — not a cast. |
| `step.ts:238` | `(effectiveOutput as { todos: unknown })` | See above. |
| `step.ts:241` | `(effectiveOutput as { todos: TodoSnapshot[] }).todos` | See above. |

The remaining "cast" sites are structural conditionals like `result.kind === "tool_call"` (`step.ts:293`), which is type-narrowing, not casting.

**Net recommendation:** export `ManageTodosOutput` type from `tools/builtins/manage_todos.ts` and add `isManageTodosOutput(x: unknown): x is ManageTodosOutput` predicate. Replace the two casts at `step.ts:238-241` with the predicate. PR-4 scope.

### Dead branches

- `step.ts:160-171` — the "ask / defer treated as allow + console.warn" arm. PR-5 ([plan:78](file:///Users/robertmoeckel/.claude/plans/develop-an-intense-code-happy-feather.md)) explicitly calls this out as a Phase 6 TODO to resolve. Currently a soft "warn and proceed" gate. **Not dead, but documented partial-implementation.**
- `step.ts:166` — `console.warn` is the explicit logger-bypass site PR-2 targets ([plan:51](file:///Users/robertmoeckel/.claude/plans/develop-an-intense-code-happy-feather.md)).
- `step.ts:289` — `if (calls.length === 0)` defensive guard "an empty batch shouldn't reach here, but if it does..." — comment says it shouldn't be reachable. The LLM provider at `llm/provider.ts` would have to return `{kind: "tool_calls", calls: []}` for this to fire. Worth verifying this is truly unreachable by adding an assertion, or document why the guard stays.
- `step.ts:330-332` — the `allReadOnly` check `calls.length > 1 && ...`. A single-element batch falls into the sequential path (`step.ts:346`); the comment at `step.ts:312-316` is explicit that this is intentional. Not dead.
- `step.ts:330-345` — fast-fail behaviour of `Promise.all` when one read-only tool throws. The comment at `step.ts:329-334` is explicit: sibling tools that already completed have their results lost. This is a documented behaviour choice; verify against tests.

### Breaking-change risk

This file is internal — `stepOnce` is called only from `core/harness.ts`. No HTTP surface. The interface is the TypeScript types `StepOnceOptions`, `StepToolOutput`, `StepOnceResult`. Tests likely import them; PR-4 should preserve names.

### Critical reuse opportunities

- The Phase 6 permission resolver at `core/permissions/resolver.ts` (referenced via `step.ts:28`, `step.ts:120-138`). This is correctly factored: the resolver does the policy check and `step.ts` consumes the decision. No re-implementation.
- `withToolSpan` (`observability/tool-spans.ts`) is correctly used at `step.ts:193-200` for OTel tool span lifecycle. No re-implementation.
- The `lifecycle.dispatch` chain (pre_tool, post_tool_failure, post_tool, post_tool_batch) consumes the singleton `Lifecycle` from `core/runtime.ts` — correctly threaded via `opts.lifecycle`.
- No use of `withUserContext` here — correct, since `step.ts` doesn't open DB transactions itself; tools that need DB do so in their `execute(...)` body.
- `AwaitingUserInputError` (`step.ts:27`, used at `step.ts:202-204`) is the established control-flow signal; correctly re-thrown rather than re-implemented.

---

## Summary of cross-file findings

### Duplications worth their own PR-5 cleanup ticket

1. **SSE static-text-completion send** (`text_delta` + `finish` + `reply.raw.end()`) repeated 4× in `chat.ts:218-226`, `236-243`, `255-263`, `277-284` and twice more in plan-mode and final-finish blocks. → Extract `sendStaticTextCompletion(reply, doStream, text)`.
2. **Paperclip reserve / release lifecycle** duplicated across `chat.ts:498-521`/`555-563`/`919-928` and `sessions.ts:514-530`/`636-645`/`665-672`. → Extract `withPaperclipReservation(opts, fn)` in `core/paperclip-client.ts`.
3. **Resume-handler post-increment branches** at `sessions.ts:278-322` and `sessions.ts:376-417` near-verbatim. → Private `_runResumeForUser` helper inside `routes/sessions/resume-handlers.ts`.
4. **Continue-message string constants** verbatim at `sessions.ts:301`, `sessions.ts:395`, and a third variant at `sessions.ts:652`. → `RESUME_CONTINUE_PROMPT` and `CHAIN_CONTINUE_PROMPT` constants.
5. **Plan-mode body** between `chat.ts:570-593` (non-streaming) and `chat.ts:646-712` (SSE) has divergent DB-persistence behaviour (`savePlanForSession` only fires on the SSE path). → Consolidate behind a single `runPlanModeTurn` helper that always persists.

### Reuse compliance — what the audit confirms

- `withUserContext` / `withSystemContext` (`db/with-user-context.ts:17-73`): every project-scoped DB read in the five files goes through these helpers (`chat.ts:166`, `sessions.ts:121`, indirectly via `loadSession` etc.). **No re-implementations.**
- `hydrateScratchpad` / `persistTurnState` (`core/session-state.ts:59-186`): both routes use them (`chat.ts:406`, `chat.ts:847`, `sessions.ts:541`, `sessions.ts:613`). **No re-implementations.**
- `loadHooks` / `BUILTIN_REGISTRARS` (`core/hook-loader.ts:94-250`): single registration path via `index.ts:486`. **No re-implementations.**
- `verifyBearerHeader` / `signMcpToken` (`security/mcp-tokens.ts`): JWT verification used at `sessions.ts:350` (the only consumer in scope). **No re-implementations.**

The CLAUDE.md "Critical files & utilities to reuse" list ([plan:137-148](file:///Users/robertmoeckel/.claude/plans/develop-an-intense-code-happy-feather.md)) is observed correctly across these five files.

### Type-safety hardening hotspots (input to PR-4)

| File | Cast count flagged in audit | Lines | Realistic post-PR-4 count |
|---|---|---|---|
| `chat.ts` | 5 | `chat.ts:334`, `chat.ts:735-736` (×2 deletes), `chat.ts:820-824` (×1 cast over scratchpad read) | 0 if `makeSseSink` accepts `omitCallbacks` and a typed `getScratchpad<T>` accessor lands. |
| `sandbox.ts` | 6 | `sandbox.ts:93-98` (×3 explicit `any`), `sandbox.ts:102`, `sandbox.ts:159`, plus 7× `(err as Error).message` | Reduce the 3 explicit `any` to `unknown` + predicate; keep the `_raw as E2BSandboxInstance` until `SandboxHandle` is generic; keep the error narrowings. |
| `step.ts` | 5 | `step.ts:238-241` (×2 same pattern). The other 3 the audit may be counting are `instanceof Error ? ... : new Error(String(err))` and structural `as` widenings. | 0 with a `ManageTodosOutput` exported type + predicate. |
| `index.ts` | 0 in audit, but found 9 (1 `as ToolBuiltin` + 8 `as (FastifyRequest) => string`) | `index.ts:174`, `index.ts:308`, `index.ts:324, 332, 336, 337, 341, 351, 355, 359` | 0 with `getUser` retyped + `Tool<unknown, unknown>` registry signature. |
| `sessions.ts` | 0 | n/a | n/a |

PR-4's stated goal "drop ≥ 80% from baseline" ([plan:72](file:///Users/robertmoeckel/.claude/plans/develop-an-intense-code-happy-feather.md)) is reachable in these five files.

### Public-API surface preservation checklist (input to PR-6)

The PR-6 split must preserve, **byte-for-byte** where applicable, the following wire-level contracts:

1. **HTTP routes:** `POST /api/chat`, `GET /api/sessions/:id`, `GET /api/sessions`, `POST /api/sessions/:id/plan/run`, `POST /api/sessions/:id/resume`, `POST /api/internal/sessions/:id/resume`. Method, path, request schema, response shape, status codes — all unchanged.
2. **SSE event names:** `text_delta`, `finish`, `error`, `plan_step`, `plan_ready`, `awaiting_user_input`, `session`, `todo_update` (the last two emitted by `makeSseSink`).
3. **Error codes:** `invalid_input`, `history_too_long`, `message_too_long`, `unauthenticated`, `not_found`, `harness_deps_missing`, `no_active_plan`, `awaiting_user_input` (HTTP 409), `auto_resume_cap_reached`, `feedback_write_failed`, `budget_exceeded`, `session_budget_exceeded`, `concurrent_modification`, `plan_mode_failed`, `internal`.
4. **Header contracts:** `x-user-entra-id` (production), `x-dev-user-entra-id` / `CHEMCLAW_DEV_USER_EMAIL` (dev), `x-request-id` (genReqId), `Authorization: Bearer <jwt>` with `agent:resume` scope on `/api/internal/sessions/:id/resume`, `Retry-After` header on Paperclip 429.
5. **Module re-exports** from `index.ts` for tests: `pool`, `registry`, `llmProvider`, `promptRegistry`, `lifecycle`, `skillLoader`, `probeMcpTools`.
6. **`StreamEvent` type re-export from `routes/chat.ts`** (`chat.ts:87`) for callers using `import type { StreamEvent } from "./chat.js"`.
7. **`runChainedHarness` export** from `routes/sessions.ts` (`sessions.ts:463`) for `tests/integration/chained-execution.test.ts`. If the function moves to `core/chained-harness.ts`, either re-export from the new `routes/sessions/index.ts` or update the test in the same PR.

A PR-6 verification step should run a `curl` snapshot of every endpoint pre-split and post-split (the plan calls for this at [plan:103](file:///Users/robertmoeckel/.claude/plans/develop-an-intense-code-happy-feather.md)) — the table above is the checklist.

---

## Code-evidence appendix

The duplications and hotspots cited above are sometimes easier to see at the code level. The snippets below are direct quotes from the audit-branch sources at the cited line numbers; nothing is paraphrased.

### A.1 The four-fold static-text-completion send pattern in `chat.ts`

`chat.ts:218-226` (unknown-verb path):

```ts
setupSse(reply);
writeEvent(reply, { type: "text_delta", delta: errText });
writeEvent(reply, {
  type: "finish",
  finishReason: "stop",
  usage: { promptTokens: 0, completionTokens: 0 },
});
reply.raw.end();
return;
```

`chat.ts:236-243` (invalid-feedback-args path):

```ts
setupSse(reply);
writeEvent(reply, { type: "text_delta", delta: errText });
writeEvent(reply, {
  type: "finish",
  finishReason: "stop",
  usage: { promptTokens: 0, completionTokens: 0 },
});
reply.raw.end();
return;
```

`chat.ts:255-263` (feedback-success path):

```ts
setupSse(reply);
writeEvent(reply, { type: "text_delta", delta: text });
writeEvent(reply, {
  type: "finish",
  finishReason: "stop",
  usage: { promptTokens: 0, completionTokens: 0 },
});
reply.raw.end();
return;
```

`chat.ts:277-284` (other-short-circuit-verb path):

```ts
setupSse(reply);
writeEvent(reply, { type: "text_delta", delta: text });
writeEvent(reply, {
  type: "finish",
  finishReason: "stop",
  usage: { promptTokens: 0, completionTokens: 0 },
});
reply.raw.end();
return;
```

The four blocks differ only in the `delta` payload string. Extracting `sendStaticTextCompletion(reply, doStream, text)` as a helper inside the proposed `routes/chat/slash-shortcircuit.ts` collapses this to four 1-line calls.

### A.2 Paperclip reserve/release lifecycle duplication

The reserve at `chat.ts:498-521` (skipping the warn-and-fall-through arms):

```ts
let paperclipHandle: ReservationHandle | null = null;
if (deps.paperclip) {
  try {
    paperclipHandle = await deps.paperclip.reserve({
      userEntraId: user,
      sessionId: sessionId ?? "stateless",
      estTokens: 12_000,
      estUsd: 0.05,
    });
  } catch (err: unknown) {
    if (err instanceof PaperclipBudgetError) {
      cleanupSkillForTurn?.();
      return void reply
        .code(429)
        .header("Retry-After", String(err.retryAfterSeconds))
        .send({
          error: "budget_exceeded",
          reason: err.reason,
          retry_after_seconds: err.retryAfterSeconds,
        });
    }
    req.log.warn({ err }, "paperclip /reserve failed (non-fatal)");
  }
}
```

The reserve at `sessions.ts:514-530`:

```ts
let paperclipHandle: ReservationHandle | null = null;
if (opts.paperclip) {
  try {
    paperclipHandle = await opts.paperclip.reserve({
      userEntraId: user,
      sessionId,
      estTokens: 12_000,
      estUsd: 0.05,
    });
  } catch (err) {
    if (err instanceof PaperclipBudgetError) {
      finalFinishReason = "budget_exceeded";
      break;
    }
    log.warn({ err }, "paperclip /reserve failed in chained-harness (non-fatal)");
  }
}
```

The reserve-shape differs in only two places: chat returns HTTP 429 + Retry-After while the chained loop sets `finalFinishReason = "budget_exceeded"; break;`. A shared helper that takes a "budget-exceeded handler" callback can collapse both:

```ts
// proposed core/paperclip-lease.ts
export async function reservePaperclipOrHandle<T>(
  client: PaperclipClient | undefined,
  reservation: PaperclipReservationInput,
  onBudgetExceeded: (err: PaperclipBudgetError) => T,
  onSoftFailure: (err: unknown) => void,
): Promise<{ handle: ReservationHandle | null } | { onBudgetResult: T }> { ... }
```

The release pattern is even more redundant. `chat.ts:555-563` (non-streaming):

```ts
if (paperclipHandle) {
  try {
    const totalTokens = promptTokens + completionTokens;
    const actualUsd = totalTokens * USD_PER_TOKEN_ESTIMATE;
    await paperclipHandle.release(totalTokens, actualUsd);
  } catch (relErr) {
    req.log.warn({ err: relErr }, "paperclip /release failed (non-fatal)");
  }
}
```

`chat.ts:919-928` (streaming finally):

```ts
if (paperclipHandle) {
  try {
    const usageSummary = budget?.summary() ?? { promptTokens: 0, completionTokens: 0 };
    const totalTokens = usageSummary.promptTokens + usageSummary.completionTokens;
    const actualUsd = totalTokens * USD_PER_TOKEN_ESTIMATE;
    await paperclipHandle.release(totalTokens, actualUsd);
  } catch (relErr) {
    req.log.warn({ err: relErr }, "paperclip /release failed (non-fatal)");
  }
}
```

`sessions.ts:636-645` (chained iteration success):

```ts
if (paperclipHandle) {
  try {
    const totalTokens = r.usage.promptTokens + r.usage.completionTokens;
    const actualUsd = totalTokens * USD_PER_TOKEN_ESTIMATE;
    await paperclipHandle.release(totalTokens, actualUsd);
  } catch (relErr) {
    log.warn({ err: relErr }, "paperclip /release failed (non-fatal)");
  }
  paperclipHandle = null;
}
```

`sessions.ts:665-672` (chained iteration catch):

```ts
if (paperclipHandle) {
  try {
    await paperclipHandle.release(0, 0);
  } catch (relErr) {
    log.warn({ err: relErr }, "paperclip /release failed in catch (non-fatal)");
  }
  paperclipHandle = null;
}
```

Four sites, same shape. A `releasePaperclipBestEffort(handle, tokens, usd, log)` helper drops 30 LOC and centralises the `USD_PER_TOKEN_ESTIMATE` use site so a future cost-model change touches one file.

### A.3 The two near-verbatim resume handlers

Public-route post-increment branch (`sessions.ts:278-322`):

```ts
const newCount = await tryIncrementAutoResumeCount(pool, user, sessionId);
if (newCount === null) {
  const after = await loadSession(pool, user, sessionId);
  if (!after) {
    return reply.code(404).send({ error: "not_found" });
  }
  if (after.lastFinishReason === "awaiting_user_input") {
    return reply.code(409).send({
      error: "awaiting_user_input",
      detail: "session is paused on a clarifying question; needs a real user reply",
    });
  }
  return reply.code(409).send({
    error: "auto_resume_cap_reached",
    cap: after.autoResumeCap,
  });
}

const continueMessages: Message[] = [
  { role: "user", content: "Continue with the next step on your todo list. If everything is done, summarize and stop." },
];

const result = await runChainedHarness({ ... maxAutoTurns: 1 });

return reply.code(200).send({
  session_id: sessionId,
  final_finish_reason: result.finalFinishReason,
  total_steps_used: result.totalSteps,
  auto_resume_count: newCount,
});
```

Internal-route post-increment branch (`sessions.ts:376-417`):

```ts
const newCount = await tryIncrementAutoResumeCount(pool, claimedUser, sessionId);
if (newCount === null) {
  const after = await loadSession(pool, claimedUser, sessionId);
  if (!after) {
    return reply.code(404).send({ error: "not_found" });
  }
  if (after.lastFinishReason === "awaiting_user_input") {
    return reply.code(409).send({
      error: "awaiting_user_input",
      detail: "session is paused on a clarifying question; needs a real user reply",
    });
  }
  return reply.code(409).send({
    error: "auto_resume_cap_reached",
    cap: after.autoResumeCap,
  });
}

const continueMessages: Message[] = [
  { role: "user", content: "Continue with the next step on your todo list. If everything is done, summarize and stop." },
];

const result = await runChainedHarness({ ... maxAutoTurns: 1 });

return reply.code(200).send({
  session_id: sessionId,
  final_finish_reason: result.finalFinishReason,
  total_steps_used: result.totalSteps,
  auto_resume_count: newCount,
});
```

The only difference is `user` vs `claimedUser` (and the initial JWT verification at `sessions.ts:347-368` upstream of the second one). A private `_runResumeForUser(req, reply, sessionId, user, deps)` collapses 80 LOC into one shared call.

### A.4 The `getUser` cast cluster in `index.ts`

```ts
// index.ts:282-293 — defines getUser with a structural-only header type
const getUser = (req: { headers: Record<string, string | string[] | undefined> }): string => {
  if (cfg.CHEMCLAW_DEV_MODE) { ... }
  const hdr = req.headers["x-user-entra-id"];
  if (typeof hdr !== "string" || hdr.length === 0) {
    throw new MissingUserError();
  }
  return hdr;
};

// 8× cast sites at index.ts:324, 332, 336, 337, 341, 351, 355, 359
getUser as (req: import("fastify").FastifyRequest) => string,
```

The structural type is genuinely a subset of `FastifyRequest`, but every consumer is a Fastify route registrar that wants the wider type. PR-4 fix: change the function signature to `(req: FastifyRequest) => string` and delete all 8 casts. No runtime behaviour change because Fastify's `req.headers` is structurally compatible.

### A.5 The E2B SDK loader's `any` triplet in `sandbox.ts`

`sandbox.ts:87-107`:

```ts
let _sdkCache: E2BSdkSandbox | null = null;

async function loadSdk(): Promise<E2BSdkSandbox> {
  if (_sdkCache) return _sdkCache;
  try {
    // Dynamic import — keeps the test bundle lightweight and avoids a hard
    // dependency on the e2b package at typecheck time. The real package is
    // installed in production; tests inject a vi.mock("e2b").
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const _importer: (spec: string) => Promise<any> = (s) => import(/* @vite-ignore */ s);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const mod: any = await _importer("e2b");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const sdk: any = mod.Sandbox ?? mod.default;
    if (!sdk || typeof sdk.create !== "function") {
      throw new Error("e2b module does not export a Sandbox.create function");
    }
    _sdkCache = sdk as E2BSdkSandbox;
    return _sdkCache;
  } catch (err) {
    throw new SandboxError("create", `e2b SDK import failed: ${(err as Error).message}`);
  }
}
```

Proposed PR-4 replacement (zero `any`, three eslint-disables removed, no behaviour change):

```ts
async function loadSdk(): Promise<E2BSdkSandbox> {
  if (_sdkCache) return _sdkCache;
  try {
    const importer: (spec: string) => Promise<unknown> = (s) => import(/* @vite-ignore */ s);
    const mod = await importer("e2b");
    const sdkCandidate = isObjectWith(mod, "Sandbox")
      ? mod.Sandbox
      : isObjectWith(mod, "default")
        ? mod.default
        : undefined;
    if (!isE2BSdkSandbox(sdkCandidate)) {
      throw new Error("e2b module does not export a Sandbox.create function");
    }
    _sdkCache = sdkCandidate;
    return _sdkCache;
  } catch (err) {
    throw new SandboxError("create", `e2b SDK import failed: ${(err as Error).message}`);
  }
}

function isObjectWith<K extends string>(x: unknown, key: K): x is Record<K, unknown> {
  return typeof x === "object" && x !== null && key in x;
}

function isE2BSdkSandbox(x: unknown): x is E2BSdkSandbox {
  return (
    typeof x === "object" &&
    x !== null &&
    "create" in x &&
    typeof (x as { create?: unknown }).create === "function"
  );
}
```

The predicate-based version preserves the exact runtime semantics of the original (same error strings, same fallback to `mod.default`).

### A.6 The `manage_todos` output cast pair in `step.ts`

`step.ts:233-243`:

```ts
if (
  streamSink?.onTodoUpdate &&
  toolId === "manage_todos" &&
  effectiveOutput &&
  typeof effectiveOutput === "object" &&
  "todos" in effectiveOutput &&
  Array.isArray((effectiveOutput as { todos: unknown }).todos)
) {
  streamSink.onTodoUpdate(
    (effectiveOutput as { todos: TodoSnapshot[] }).todos,
  );
}
```

The first cast is a runtime guard; the second is the load-bearing assertion. The right shape is a Zod-derived type from the `manage_todos` tool builder. Looking at the registration site at `index.ts:257`:

```ts
registry.registerBuiltin("manage_todos", () => asTool(buildManageTodosTool(pool)));
```

The builder's output schema (in `tools/builtins/manage_todos.ts`) is the source of truth. Exporting `type ManageTodosOutput = z.infer<typeof outputSchema>` from that module and importing in `step.ts` lets us write:

```ts
import { isManageTodosOutput } from "../tools/builtins/manage_todos.js";

if (
  streamSink?.onTodoUpdate &&
  toolId === "manage_todos" &&
  isManageTodosOutput(effectiveOutput)
) {
  streamSink.onTodoUpdate(effectiveOutput.todos);
}
```

Both casts go away. The predicate is canonically defined at the producer.

### A.7 The `sink.delete` workaround at `chat.ts:732-736`

```ts
const sink = makeSseSink(reply, _streamRedactions, sessionId ?? undefined);
// Strip the two callbacks the route owns. The sink object is freshly
// built here so deleting on it doesn't leak anywhere else.
delete (sink as { onAwaitingUserInput?: unknown }).onAwaitingUserInput;
delete (sink as { onFinish?: unknown }).onFinish;
```

`makeSseSink` (`streaming/sse-sink.ts:41-`) returns a fully-populated `StreamSink`; the route then strips two callbacks because it owns the emission order for `awaiting_user_input` (must redact + persist first) and `finish` (must come after `session_end` dispatch). The type cast and `delete` is the syntactic price of overriding a sink-builder default after the fact.

A cleaner API: accept an opt-out parameter:

```ts
// proposed streaming/sse-sink.ts
export interface MakeSseSinkOptions {
  reply: FastifyReply;
  streamRedactions: RedactReplacement[];
  sessionId?: string;
  /** Callback names the caller will emit themselves. Suppressed at build time. */
  omitCallbacks?: ReadonlyArray<keyof StreamSink>;
}

export function makeSseSink(opts: MakeSseSinkOptions): StreamSink { ... }
```

Then `chat.ts:732-736` becomes:

```ts
const sink = makeSseSink({
  reply,
  streamRedactions: _streamRedactions,
  sessionId: sessionId ?? undefined,
  omitCallbacks: ["onAwaitingUserInput", "onFinish"],
});
```

No structural cast, no delete, contract is now self-documenting. PR-4 candidate.

### A.8 The post-split contract checklist for PR-6

Below is the wire-level snapshot that PR-6's verification must produce identical results from before and after the split. Each row is a `curl` invocation that should yield byte-identical JSON / SSE.

| # | Method + path | Body / headers | Expected codes |
|---|---|---|---|
| 1 | `GET /healthz` | none | 200 `{ok:true}` (or whatever `registerHealthzRoute` returns) |
| 2 | `GET /readyz` (Postgres up, mcp_tools healthy) | none | 200 `{status:"ready"}` |
| 3 | `GET /readyz` (Postgres up, no healthy mcp_tools) | none | 503 `{status:"not_ready", reason:"no_healthy_mcp_tools"}` |
| 4 | `POST /api/chat` (production) | no header | 401 `{error:"unauthenticated"}` |
| 5 | `POST /api/chat` | bad JSON | 400 `{error:"invalid_input", detail:[...]}` |
| 6 | `POST /api/chat` | history > cap | 413 `{error:"history_too_long", max:N}` |
| 7 | `POST /api/chat` | message > cap | 413 `{error:"message_too_long", max:N}` |
| 8 | `POST /api/chat` | `/help` slash, `stream:false` | 200 `{text:HELP_TEXT}` |
| 9 | `POST /api/chat` | `/help` slash, `stream:true` | SSE: `text_delta` + `finish(stop)` |
| 10 | `POST /api/chat` | `/feedback bogus`, `stream:false` | 200 `{text:"Invalid /feedback syntax..."}` |
| 11 | `POST /api/chat` | `/feedback up "good"`, `stream:false` | 200 `{text:"Thanks for your feedback (up)."}` |
| 12 | `POST /api/chat` | `/junk`, `stream:false` | 200 `{text:"Unknown command /junk. Try /help."}` |
| 13 | `POST /api/chat` | normal turn, `stream:false` | 200 `{text, finishReason, usage}` |
| 14 | `POST /api/chat` | normal turn, `stream:true` | SSE: `session` then `text_delta`* then `finish(stop)` |
| 15 | `POST /api/chat` | over Paperclip budget | 429 with `Retry-After` and `{error:"budget_exceeded", reason, retry_after_seconds}` |
| 16 | `POST /api/chat` | session cap blown mid-stream | SSE: `error(session_budget_exceeded)` then `finish(session_budget_exceeded)` |
| 17 | `POST /api/chat` | `/plan ...`, `stream:false` | 200 `{plan_id, steps[], created_at}` |
| 18 | `POST /api/chat` | `/plan ...`, `stream:true` | SSE: `session` + `plan_step`* + `plan_ready` + `finish(plan_ready)` |
| 19 | `POST /api/chat` | `ask_user` fired mid-stream | SSE: `awaiting_user_input(session_id, question)` then `finish(awaiting_user_input)` |
| 20 | `GET /api/sessions/:id` (UUID, not found) | header `x-user-entra-id` | 404 `{error:"not_found"}` |
| 21 | `GET /api/sessions/:id` (bad uuid) | header | 400 `{error:"invalid_input", detail:"session id must be a UUID"}` |
| 22 | `GET /api/sessions/:id` (found) | header | 200 with `session_id, todos[], awaiting_question, last_finish_reason, message_count, created_at, updated_at` |
| 23 | `GET /api/sessions?limit=5` | header | 200 `{sessions:[...]}` |
| 24 | `POST /api/sessions/:id/plan/run` (no plan) | header | 404 `{error:"no_active_plan"}` |
| 25 | `POST /api/sessions/:id/plan/run` (active plan, completes) | header | 200 with all 5 fields including `plan_progress` |
| 26 | `POST /api/sessions/:id/resume` (cap reached) | header | 409 `{error:"auto_resume_cap_reached", cap:N}` |
| 27 | `POST /api/sessions/:id/resume` (awaiting input) | header | 409 `{error:"awaiting_user_input", detail:...}` |
| 28 | `POST /api/sessions/:id/resume` (success) | header | 200 with 4 fields |
| 29 | `POST /api/internal/sessions/:id/resume` (no auth) | none | 401 `{error:"unauthenticated", detail:"Authorization: Bearer <jwt> required"}` |
| 30 | `POST /api/internal/sessions/:id/resume` (bad JWT) | bad bearer | 401 `{error:"unauthenticated", detail:<McpAuthError msg>}` |
| 31 | `POST /api/internal/sessions/:id/resume` (good JWT, success) | bearer (`agent:resume` scope) | 200 with 4 fields |

If PR-6 produces an exact diff-zero between this 31-row matrix before and after the split, the public surface is preserved. The CLAUDE.md project doc's note about hooks-table parity also requires that the `loadHooks` count after split still hits `MIN_EXPECTED_HOOKS = 11`.

---

## Recommended PR sequencing for the five files

Given Wave 2's PR-1 → PR-8 ordering ([plan:133](file:///Users/robertmoeckel/.claude/plans/develop-an-intense-code-happy-feather.md)):

1. **PR-2 (logging)** — replaces the `console.warn` at `step.ts:166` and `sandbox.ts:243` with Pino. Touches 2 lines per file. Lowest risk.
2. **PR-3 (streaming abort)** — addresses `chat.ts:632-637` TODO. Threads `AbortSignal` through `runHarness` and `step.ts`. Touches `chat.ts`, `step.ts` (and `harness.ts` out of scope here). Medium risk.
3. **PR-4 (type-safety)** — kills the `any` casts in `sandbox.ts` (6 → 0), `step.ts` (≤2 → 0), `chat.ts` (3 → 0), and the `getUser` cast cluster in `index.ts` (8 → 0). Medium risk.
4. **PR-5 (cleanup)** — resolves stale TODOs at `step.ts:160`, the partial output-cap comment at `chat.ts:367-371`, and runs `ts-prune` over the agent-claw service. Low risk.
5. **PR-6 (split)** — the structural refactor. Lands AFTER PR-4 so the new modules inherit clean types from day one. High risk; verification trio (`etag-conflict`, `chained-execution`, `reanimator-roundtrip`) plus the 772+ existing agent-claw unit tests must stay green. The `curl` snapshot of every public endpoint is the diff-resilient regression check.

Track A's recommendation: do **not** merge PR-6 before PR-4. The `any`-cast removals constrain the post-split module boundaries (e.g. the new `chat/end-of-turn.ts` should not inherit casts that PR-4 is about to delete), and merging in the reverse order means PR-4 has to land changes across 8+ new files instead of 5 existing ones.
