# Tier 4 / A15 — Error handling, resilience, observability

Audit of error paths against current `main` (HEAD = 58d3936). Ran tsc + 1127
agent-claw tests + 90 mcp_tools tests + 61 projector tests + 20 queue tests
clean after the edits described below. No commit / push (per scope).

---

## 1. `services/agent-claw/src/observability/with-retry.ts`

Verdict: **CLEAN**.

- Bounded attempts (default 3), exponential backoff (`baseMs * multiplier^(n-1)` capped at `maxMs`), ±25 % jitter.
- AbortSignal is honoured at three points: top-of-loop (`signal.aborted` re-throws `signal.reason`), inside the catch arm (`isAbortError` short-circuits), and inside the sleep executor (a new `setTimeout` is cleared on abort, then the post-sleep guard re-throws).
- The `shouldRetry` predicate is the chosen surface for "do not retry 4xx with semantic meaning"; `withRetry` does not assume HTTP status itself, deferring to the caller. (`mcp/postJson.ts` already passes a 4xx-skipping predicate; not in scope here.)
- One non-load-bearing silent catch at L184 in `describeUnknown` — JSON.stringify fallback, intentional, returns `<unserializable>`. Acceptable.

No fixes.

## 2. `services/agent-claw/src/core/lifecycle.ts`

Verdict: **fixed — log line was missing context**.

- Per-hook AbortController + 60 s default timeout: race wraps the handler in `Promise.race` with an abort-rejection promise, so a hook ignoring its `signal` cannot stall the dispatcher beyond `hook.timeout`. Confirmed.
- The non-`pre_tool` swallow path at L259 logs `event=hook_failed` + `point` + `hook_name` + `err_name` + `err_msg`. **Missing**: the originating request id and the matcher target / tool-use id (relevant for `post_tool` hook failures keyed off a specific `toolId`).
- **Fix**: pulled the request id off the AsyncLocalStorage `RequestContext` and added `request_id`, `matcher_target`, `tool_use_id` to the structured payload. A Loki search now jumps from a single `hook_failed` line to the originating HTTP request's full trail.

## 3. `services/agent-claw/src/core/harness.ts` AbortError detection across pre_turn dispatch sites

Verdict: **fixed — sub-agent leaked, plan + DR-non-stream conflated abort with 500**.

The four runHarness call paths:

| Site | AbortError handling | Verdict |
|---|---|---|
| `routes/chat.ts` streaming | `classifyStreamError` → `cancelled` finishReason → terminal SSE `cancelled`+`finish` | clean |
| `routes/chat-non-streaming.ts` | `chat-non-streaming-error.ts` mirrors classifier | clean |
| `routes/deep-research.ts` streaming | local `_isAbortLikeError` → SSE `cancelled` | clean |
| `routes/deep-research.ts` non-streaming | **bug**: any throw → `reply.code(500).send({error:"internal"})` regardless of cause | **fixed** — now `499 cancelled` for AbortError, 500 only for genuine failures |
| `routes/plan.ts` streaming | **bug**: any throw → SSE `error="internal"` regardless of cause | **fixed** — now emits SSE `cancelled` when `isAbortLikeError(err) || req.signal.aborted` |
| `core/sub-agent.ts` | **bug**: did NOT thread the parent's AbortSignal into the sub-harness | **fixed** — now passes `signal: parentCtx.signal` |

The sub-agent fix matters: a parent cancelled mid-stream (client disconnect) was leaving any in-flight sub-agent running to its own budget cap, burning tokens against an already-closed SSE stream. The parent's `ctx.signal` was already populated by `harness.ts:84`, so threading it into `runHarness` for the sub closes the loop.

## 4. `services/projectors/common/base.py` PermanentHandlerError vs transient

Verdict: **CLEAN**.

`_process_row` is unambiguous: `PermanentHandlerError` → `should_ack=True` (logged at WARNING with `error_code=PROJECTOR_HANDLER_FAILED_PERMANENT` and `duration_ms`); any other `Exception` → `should_ack=False` and `log.exception` (full traceback) with `error_code=PROJECTOR_HANDLER_FAILED_TRANSIENT`. Distinct event codes, distinct ack semantics, both surfaced. No silent paths. The reconnect-loop catches `psycopg.OperationalError` / `OSError` only and re-raises everything else — handler bugs cannot accidentally be classified as transient DB blips.

## 5. `services/mcp_tools/common/app.py` error envelope consistency

Verdict: **fixed — generic Exception path returned plain-text Starlette body**.

- `ValueError` → `400 {error:"invalid_input", detail:str(exc)}` ✓
- `HTTPException` → `{error: code_map[status], detail}` with the full code map + `x-request-id` echo ✓
- Anything else → previously fell through to Starlette's default `500 Internal Server Error` plaintext, breaking the `{error, detail}` contract every MCP client (agent-claw `postJson`, `queue/worker.py`) relies on.
- **Fix**: added `@app.exception_handler(Exception)` that returns `500 {error:"internal", detail:"internal server error"}` + `x-request-id`, and emits one structured log line `event=mcp_unhandled_exception` with method/path/err_type so cross-service Loki searches still tie the failed response to its trace. Starlette still emits the full traceback via its own logger so we don't double-log.

## 6. `services/queue/worker.py` failure path

Verdict: **partially fixed — handler exception was logless**; race conditions deferred.

- `_handle` previously caught every handler exception and silently called `_maybe_retry(row, str(exc))`. Operators saw nothing until the retry ladder exhausted into `_fail`.
- **Fix**: structured WARNING `event=queue_handler_failed` with `task_id`, `task_kind`, `attempt`, `max_attempts`, `err_type`, `err_msg`. Now visible per-attempt.
- `_maybe_retry` exponential backoff cap (1 hr) is correct; `attempts++` is performed by `_lease_one` before handoff, so the exponent computation `30 * 2^(attempts-1)` is right.

**Deferred to BACKLOG** (per scope: queue dead-letter shape / lease-race redesign):

- `_succeed` / `_fail` / `_maybe_retry` do not re-check `leased_by = self._lease_id` on the UPDATE. If a handler runs longer than `queue_lease_seconds`, `_sweep_all` reverts the row to `pending`, a sibling worker re-leases it (attempts++), and the original `_succeed` then overwrites the second lease's outcome. Race window is bounded by lease duration but real.
- Each of the three terminal-state writers opens a fresh `psycopg.AsyncConnection`. Connection storms under load are a possibility; reusing `work_conn` is the right shape.

## 7. Swallowed-exception sweep (production paths only)

Format: `file:line — verdict — fix?`

| Site | Verdict | Action |
|---|---|---|
| `core/confidence.ts:149` (`crossModelAgreement`) | silent swallow with no log; the `null` return looks identical to "judge said unknown" | **fixed** — `event=cross_model_agreement_failed` with err_name/err_msg |
| `core/compactor.ts:144` | LLM compaction failure silently degraded prompt window | **fixed** — `event=compactor_llm_failed` + fallback chars on the log |
| `prompts/shadow-evaluator.ts:132` | fire-and-forget evaluator silently swallowed all errors; broke the `skill_promoter` "no shadow scores in 24 h" alert breadcrumb trail | **fixed** — `event=shadow_eval_failed` + prompt_name |
| `config/flags.ts:99` | DB-unavailable kept stale cache silently for hours | **fixed** — `event=feature_flags_refresh_failed` + `using_stale_cache` |
| `routes/learn.ts:84` | LLM distillation failure silently populated `skill_library` with raw transcripts | **fixed** — `req.log.warn` with err + title |
| `routes/deep-research.ts:128` | logged "prompt not found" without err field | **fixed** — pass err |
| `routes/eval.ts:152` | catch then `activeTemplate=null` (clearly-documented test-path fallback) | acceptable |
| `routes/feedback.ts:110` | promptRegistry miss → leave link cols NULL (documented) | acceptable |
| `routes/forged-tools.ts:122` | missing-script-file → 404 (documented) | acceptable |
| `routes/admin/admin-config.ts:179, 240` | `getConfigRegistry().invalidate` in unit-test path | acceptable |
| `routes/admin/admin-flags.ts:122, 158` | same shape (singleton-not-init in tests) | acceptable |
| `core/hook-loader.ts:190, 208, 216, 330` | each pushes `result.skipped`; surfaces at boot | acceptable |
| `core/hooks/permission.ts:30` | un-stringifiable input → fail-to-match (documented) | acceptable |
| `bootstrap/probes.ts:80` | fetch failure → mark unhealthy (documented) | acceptable |
| `streaming/sse.ts:64` | wraps in structured warn already | clean |
| `routes/chat-streaming-sse.ts:53, 65` | "socket already gone" best-effort writes | acceptable |
| `routes/chat-non-streaming.ts:76, 78, 132` | `recordSpanError` / `span.end()` defensive try/catch | acceptable |
| `core/chained-harness.ts:189, 273, 300, 357, 374` | every catch arm logs with `log.warn`/`log.error` | clean |
| `db/with-user-context.ts:67, 71` | rollback path logged | clean |
| `bootstrap/start.ts:52, 74, 83, 91, 104` | structured logging present | clean |
| `core/sandbox.ts:165, 185, 203, 240, 250, 259` | logged | clean |
| `security/mcp-token-cache.ts:120` | `McpAuthError` rethrown (intentional) | clean |
| `security/workspace-boundary.ts:80` | missing root → skip (documented) | clean |
| `prompts/shadow-evaluator.ts:86` | structural-fact-id JSON.stringify guard (documented) | acceptable |
| `llm/litellm-provider.ts:45` | JSON-or-string fallback (documented) | acceptable |
| `observability/with-retry.ts:184` | `describeUnknown` JSON.stringify guard (documented) | acceptable |

## 8. What is fixed vs deferred

**Fixed in this audit:**

1. `core/sub-agent.ts` — propagate parent AbortSignal into sub-harness.
2. `core/lifecycle.ts` — `hook_failed` log adds `request_id`, `matcher_target`, `tool_use_id`.
3. `routes/plan.ts` — distinguish AbortError from server failure; emit SSE `cancelled` instead of `error="internal"`.
4. `routes/deep-research.ts` (non-streaming) — distinguish AbortError; return `499 cancelled` instead of `500 internal`.
5. `routes/deep-research.ts` (prompt fallback log) — pass `err` field.
6. `core/confidence.ts` — log cross-model agreement failures.
7. `core/compactor.ts` — log compactor LLM failures.
8. `prompts/shadow-evaluator.ts` — log shadow eval failures.
9. `config/flags.ts` — log feature_flags DB refresh failures.
10. `routes/learn.ts` — log LLM distillation failure path.
11. `services/queue/worker.py` — log per-attempt handler failures.
12. `services/mcp_tools/common/app.py` — generic `Exception` handler returns standard `{error, detail}` envelope.

**Deferred to `BACKLOG.md` (per scope constraints):**

- `[queue/worker] _succeed/_fail/_maybe_retry should scope UPDATE to leased_by=self._lease_id; race with lease expiry can cause double-update`
- `[queue/worker] consolidate _succeed/_fail/_maybe_retry onto the existing work_conn instead of opening a fresh AsyncConnection per terminal write`
- `[mcp_tools/common/app] add a circuit breaker around the per-route handler — current model retries every transient failure to budget`
- `[agent-claw/with-retry] retry-budget redesign per top-level prompt — out of scope today`

## 9. Verification

```
services/agent-claw  npx tsc --noEmit               -> clean
services/agent-claw  npm test                       -> 1127 passed (154 files)
.venv/bin/pytest services/mcp_tools/common/tests/   -> 90 passed
.venv/bin/pytest services/projectors/               -> 61 passed
.venv/bin/pytest services/queue/tests/              -> 20 passed
```

No commits, no PR (per scope). Diff stat:

```
services/agent-claw/src/config/flags.ts                    | +17/-3
services/agent-claw/src/core/compactor.ts                  | +16/-2
services/agent-claw/src/core/confidence.ts                 | +16/-2
services/agent-claw/src/core/lifecycle.ts                  | +12/-2
services/agent-claw/src/core/sub-agent.ts                  | (signal-prop block)
services/agent-claw/src/prompts/shadow-evaluator.ts        | +18/-2
services/agent-claw/src/routes/deep-research.ts            | (DR non-stream block)
services/agent-claw/src/routes/learn.ts                    | +10/-2
services/agent-claw/src/routes/plan.ts                     | (cancelled-vs-error block)
services/mcp_tools/common/app.py                           | +30
services/queue/worker.py                                   | +19
```
