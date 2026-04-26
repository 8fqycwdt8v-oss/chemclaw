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

## Out of scope for first cut

- **Plan v2 (DB-backed plans + chaining).** The existing in-memory 5-min `planStore` is fine for what `/plan` does today (single-shot preview). Migrating it to the new session table is a follow-up; the new session infra makes it easy.
- **Cross-turn budget accumulation.** The existing per-turn budget is a known cap. After Phase A lands, persisting `tokens_used_in_session` is a one-column addition.
- **Auto-resume cron.** Today the client decides when to POST. A cron-style "wake the agent every 5 min if a session has unfinished todos" would close the loop on truly multi-day tasks but is its own design.
- **Sub-agent persistence.** Sub-agents stay isolated for now; folding their `seenFactIds` into the parent session is a follow-up.
- **Concurrent edits to the same session.** Two browser tabs writing to the same session_id will race; we'll use last-writer-wins for now and add an `etag` column later if needed.

## Acceptance

After all four phases:
- A user starts `/api/chat` without `session_id` → gets a `session` event back.
- LLM calls `manage_todos` → user's UI updates with the checklist.
- LLM calls `ask_user` mid-investigation → SSE stream ends with `awaiting_user_input`.
- User POSTs `/api/chat` with the same `session_id` + their answer → agent resumes with full context, the checklist still visible.
- `GET /api/sessions/:id` always reflects current state.
- `npm test`: passes; `npx tsc --noEmit`: clean.
