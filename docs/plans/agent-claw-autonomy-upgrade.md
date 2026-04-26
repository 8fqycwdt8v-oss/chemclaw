# Agent-claw autonomy upgrade — Claude-Code-parity plan mode

**Goal:** Make `services/agent-claw/` capable of multi-hour autonomous work with the same affordances Claude Code has — persistent state across turns, a checklist the LLM writes and the user watches update, the ability to pause and ask a clarifying question, and the ability to chain plan steps without the client needing to re-POST history.

**Non-goal:** Re-implementing every Claude Code feature. We're after the minimum surface that delivers the experience.

## What's there today

- **Plan mode** (`core/plan-mode.ts` + `routes/plan.ts`): single-shot. `/plan` → typed `PlanStep[]` → user approves → `/api/chat/plan/approve` runs the harness once → ends.
- **Sub-agents** (`core/sub-agent.ts`): three types (chemist/analyst/reader), tool-subset enforcement, isolated sub-context.
- **Per-turn budget** (`core/budget.ts`): 40 steps + 120k tokens, fresh per request.
- **Per-turn scratchpad** (`ToolContext.scratchpad`): a `Map<string, unknown>` discarded when the SSE stream closes.

## What's missing

1. **No persistent session.** The agent has amnesia between `/api/chat` calls.
2. **No checklist.** Nothing analogous to Claude Code's `TodoWrite`.
3. **No clarification-back event.** SSE has no `awaiting_user_input` type; the loop can't pause.
4. **No plan chaining.** After `/plan/approve` runs once, you're done.
5. **No cross-turn budget.** A long-running task has no session-level cap.

## Implementation plan (5 phases, each independently shippable)

### Phase A — Persistent session state *(foundation)*

**A1 Schema.** New file `db/init/13_agent_sessions.sql`:
- `agent_sessions(id uuid pk, user_entra_id text, scratchpad jsonb, last_finish_reason text, awaiting_question text, message_count int, created_at, updated_at, expires_at)`
- `agent_todos(id uuid pk, session_id uuid → agent_sessions(id) on delete cascade, ordering int, content text, status text check in ('pending','in_progress','completed','cancelled'), created_at, updated_at)`
- RLS on both: scoped by `user_entra_id` (FORCE). System workers bypass via `chemclaw_service`.
- Index on `(user_entra_id, updated_at desc)` for resume listing.
- TTL: 7 days default. A nightly job cleans expired sessions (out of scope for first cut; `expires_at` is decorative until then).

**A2 SessionStore TS layer.** New file `services/agent-claw/src/core/session-store.ts`:
- `loadSession(pool, userEntraId, sessionId)` → `SessionState | null`
- `saveSession(pool, userEntraId, sessionId, state)`
- `createSession(pool, userEntraId)` → `sessionId`
- All wrapped in `withUserContext(pool, userEntraId, ...)` so RLS gates the load.

**A3 Wire into `/api/chat`.** `routes/chat.ts`:
- Accept optional `session_id` in `ChatRequestSchema`.
- If present: load session, hydrate `ctx.scratchpad` from `state.scratchpad`, set `ctx.scratchpad.session_id = session_id`.
- If absent: create a new session, emit a `session` SSE event with `{ session_id }` so client can resume.
- After `post_turn` dispatch in the `finally` block: persist `ctx.scratchpad` + finish reason back to the session row.
- Tests: round-trip scratchpad across two POSTs.

### Phase B — TodoWrite-equivalent

**B1 `manage_todos` builtin.** New file `services/agent-claw/src/tools/builtins/manage_todos.ts`:
- Input: `{ action: 'create' | 'update' | 'complete' | 'cancel' | 'list', todos?: { content: string }[], todo_id?: string, status?: TodoStatus }`
- Reads `session_id` from `ctx.scratchpad`. If absent, returns an explanatory error so the LLM doesn't try to call this tool outside a session context.
- Persists to `agent_todos`. Returns the full updated list so the LLM's next call sees the new state.

**B2 `todo_update` SSE event + prompt nudge.** `routes/chat.ts`:
- After every successful `manage_todos` `post_tool` hook, emit a `todo_update` event with the updated todos array. This is the "user watches the checklist tick" affordance.
- System prompt addition (in `prompt_registry`, not hardcoded): "For tasks requiring 3+ steps, call `manage_todos` first to create a plan; mark each item `in_progress` before starting and `completed` immediately after."

### Phase C — Clarification-back

**C1 `ask_user` builtin + `awaiting_user_input` event.** New file `services/agent-claw/src/tools/builtins/ask_user.ts`:
- Input: `{ question: string }` (length-bounded, plain text, no markdown injection surface).
- Implementation: sets `ctx.scratchpad.awaiting_question = question` and throws a typed `AwaitingUserInputError`.
- Harness loop catches it (without treating it as a generic failure):
  - Persists session state (the existing `post_turn` save handles this if we land it after Phase A).
  - Emits `awaiting_user_input` SSE event with `{ session_id, question }`.
  - Emits `finish` with `finishReason: "awaiting_user_input"`.
  - Closes the stream cleanly.
- Resume path: client POSTs `/api/chat` with `session_id` + a new user message containing the answer. The harness loads the session, sees `awaiting_question` set, clears it, appends the user's answer to messages, continues the loop.

This is the single biggest unlock for autonomous multi-hour work — the agent can plow through an investigation, surface a "should I proceed with X or Y?" mid-flight, and the user can answer days later without losing the entire context.

### Phase D — Sessions status endpoint

**D1 `GET /api/sessions/:id`.** New file `services/agent-claw/src/routes/sessions.ts`:
- Returns `{ session_id, todos, awaiting_question, last_finish_reason, message_count, created_at, updated_at }`.
- Auth-gated by `getUser`; reads via `withUserContext` so RLS scopes to the calling user's own sessions.
- Optional `GET /api/sessions` (no id) — list the user's recent sessions, ordered by `updated_at desc`. Useful for "resume my chat" UI.

### Phase D2 — Tests + commits

- Unit tests for `session-store` round-trip, `manage_todos` CRUD, `ask_user` event emission + state persistence, `/api/sessions/:id` shape.
- One commit per phase (A, B, C, D). The diff for each is contained enough to bisect.

## Phase E — Plan v2 (DB-backed plans + chaining)

**Why:** Today's `/plan` writes to an in-memory 5-min `planStore` and runs once on approval. That's single-shot — there's no chaining if a plan exceeds `max_steps`. To support "investigate batch 7 across 8 hours of tool calls", we need plans that survive turn boundaries and auto-continue.

**Schema** (`db/init/14_agent_plans.sql`):
- `agent_plans(id uuid pk, session_id uuid → agent_sessions, steps jsonb, current_step_index int default 0, status text check in ('proposed','approved','running','completed','cancelled','failed'), created_at, updated_at)`
- RLS via parent session.

**Code:**
- `core/plan-store.ts` — replace the in-memory `planStore` Map with `loadPlan` / `savePlan` / `advancePlan` against the new table.
- `routes/plan.ts` — `/plan/approve` creates a row with status='approved' instead of looking up an in-memory ID.
- `routes/chat.ts` — when invoked with `plan_id` set, after each user-visible turn, if the plan still has `current_step_index < steps.length`, immediately recurse without waiting for a new user message (bounded by `AGENT_PLAN_MAX_AUTO_TURNS`).
- New SSE event: `plan_progress` (`current_step_index`, `total_steps`, `last_step_status`).

## Phase F — Cross-turn budget accumulation

**Why:** The existing `Budget` class is per-turn — every `/api/chat` POST resets prompt+completion counters. A long-running session has no session-level cap; a runaway plan could burn unlimited tokens.

**Schema:** `agent_sessions` add `session_input_tokens BIGINT NOT NULL DEFAULT 0`, `session_output_tokens BIGINT NOT NULL DEFAULT 0`, `session_steps INT NOT NULL DEFAULT 0`, `session_token_budget BIGINT` (NULL = use env default).

**Code:**
- `core/budget.ts` — add an optional `sessionBudget?: { used, cap }` parameter; `consumeStep` increments both per-turn and session counters. `isStepCapReached()` honors both caps.
- `routes/chat.ts` — load session totals into Budget at turn start; save back at turn end.
- New error variant: `SessionBudgetExceededError`. Surfaces as HTTP 429 from `/api/chat`.
- Env var: `AGENT_SESSION_TOKEN_BUDGET` (default 1_000_000).

## Phase G — Sub-agent persistence

**Why:** Sub-agents harvest `seenFactIds` (citations the sub-agent grounded its answer on). Today those facts vanish at sub-agent exit; the parent's anti-fabrication hook can't tell that the sub-agent's answer is grounded in real facts. The parent re-checks against its own `seenFactIds` Set and over-rejects.

**Code:**
- `core/sub-agent.ts` — `SubAgentResult` already carries `citations: string[]`. Add a `mergeIntoParent: boolean = true` option (default merge).
- `tools/builtins/dispatch_sub_agent.ts` — after the sub-agent returns, if `mergeIntoParent`, do `for (const id of result.citations) parentCtx.seenFactIds.add(id)`. The parent's anti-fabrication hook now sees the union.

## Phase H — etag concurrency

**Why:** Two browser tabs editing the same session race. Last-writer-wins corrupts the scratchpad. An optimistic-concurrency token detects + rejects the conflict.

**Schema:** `agent_sessions` add `etag UUID NOT NULL DEFAULT uuid_generate_v4()`. Update trigger regenerates etag on every `UPDATE`.

**Code:**
- `core/session-store.ts` — `loadSession` returns `etag`; `saveSession` accepts optional `expectedEtag`. Uses `UPDATE ... WHERE id = $id AND etag = $expected RETURNING etag`. If RETURNING is empty → throw `OptimisticLockError`.
- `routes/chat.ts` — load etag at turn start, pass as `expectedEtag` on save. On mismatch, surface `409` (or the SSE equivalent: emit `error` event with `code: "concurrent_modification"`).

## Phase I — Auto-resume

**Why:** Truly-multi-day autonomous work needs a "wake the agent" mechanism. Today the agent only runs when the client POSTs.

**Code:**
- `routes/sessions.ts` — `POST /api/sessions/:id/resume`. Auth-gated by admin role + session ownership. If `last_finish_reason` ∈ {`max_steps`, `stop`} (NOT `awaiting_user_input` — that needs human input) AND there are `in_progress` todos AND session-budget not exceeded → run one harness turn with a synthetic user message (`"Continue with the next step on your todo list."`). Returns the updated session state.
- New service `services/optimizer/session_reanimator/` — Python `apscheduler` worker. Polls every 5 min: `SELECT id FROM agent_sessions WHERE last_finish_reason = 'max_steps' AND updated_at < NOW() - INTERVAL '5 minutes' AND session_input_tokens < session_token_budget AND id IN (SELECT session_id FROM agent_todos WHERE status = 'in_progress') LIMIT 10`. For each, POST `/api/sessions/:id/resume`.
- Cap auto-resumes per session: `agent_sessions.auto_resume_count INT DEFAULT 0`. Cron stops at 10 resumes (configurable). Prevents infinite loops.

## Acceptance

After all four phases:
- A user starts `/api/chat` without `session_id` → gets a `session` event back.
- LLM calls `manage_todos` → user's UI updates with the checklist.
- LLM calls `ask_user` mid-investigation → SSE stream ends with `awaiting_user_input`.
- User POSTs `/api/chat` with the same `session_id` + their answer → agent resumes with full context, the checklist still visible.
- `GET /api/sessions/:id` always reflects current state.
- `npm test`: passes; `npx tsc --noEmit`: clean.
