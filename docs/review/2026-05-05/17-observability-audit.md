# A17 — Observability audit (per-hook + per-tool spans, projector correlation)

Scope: Langfuse / OTLP span coverage for every harness call site, the
permission resolver decision tag on tool spans, request_id propagation
through projectors, error_events write path, structured log fields.

Baseline: post-PR-#97 main (PR #87 = DR-02 configure_logging rollout in
five projectors; PR #93 = Python redaction_filter for exc_text/stack_info;
PR #96 = TS Pino err serializer + redact-string.ts). None re-flagged.

## 1. Span coverage matrix

| Call site                                              | rootSpan? | otelContext.with wrap? | Hook/tool spans nested? |
|-------------------------------------------------------|-----------|-----------------------|-------------------------|
| /api/chat (non-streaming, plan-mode)                   | yes       | yes                   | yes                     |
| /api/chat (streaming)                                  | yes       | **fixed (was no)**    | yes (after fix)         |
| /api/chat/plan/approve (plan.ts)                       | **fixed (was no)** | **fixed**     | yes (after fix)         |
| /api/deep_research (stream + non-stream)               | **fixed (was no)** | **fixed**     | yes (after fix)         |
| /api/sessions/:id/plan/run (chained-harness, per turn) | **fixed (was no)** | **fixed**     | yes (after fix)         |
| /api/sessions/:id/resume (chained-harness, per turn)   | **fixed (was no)** | **fixed**     | yes (after fix)         |
| /api/internal/sessions/:id/resume (reanimator)         | **fixed (was no)** | **fixed**     | yes (after fix)         |
| sub-agent.spawnSubAgent (chemist/analyst/reader)       | **fixed (was no)** | **fixed**     | yes (after fix)         |

Hook-level spans (`hook.{point}.{name}`) and tool-level spans
(`tool.{toolId}`) are emitted via `tracer.startActiveSpan` from
`observability/hook-spans.ts` + `observability/tool-spans.ts`; they nest
under whichever span is active when the harness body runs. Before this
audit, only `/api/chat`'s non-streaming and plan-mode branches wrapped
their `runHarness` / `completeJson` in `otelContext.with(turnCtx, …)`,
so streaming chat, plan-approve, deep-research, both chained-execution
flows, and every sub-agent dispatched hook + tool spans as orphans of
the request-level Fastify span (or the no-op tracer when OTEL is
unconfigured). Langfuse's GEPA tag-filtered fetch
(`prompt:agent.system`) silently missed every one of those traces.

## 2. Required span attributes — verified

`hook.{point}.{name}` spans (hook-spans.ts):
  - `hook.point`, `hook.name`, `hook.matcher_target`, `hook.tool_use_id`,
    `hook.duration_ms`, OK/ERROR status, recordException on throw.

`tool.{toolId}` spans (tool-spans.ts):
  - `tool.id`, `tool.read_only`, `tool.in_batch`, `tool.duration_ms`,
    OK/ERROR status, recordException on throw.
  - **NEW (this audit)**: `permission.decision` (`allow` / `ask` /
    `skipped`) + `permission.reason` (when supplied) — sourced from
    `resolveDecision(...)` and threaded through `_runOneTool` into
    `withToolSpan` in `services/agent-claw/src/core/step.ts`. `deny` /
    `defer` short-circuit before the tool span opens, so they never
    appear as a tool-span tag (the resolver-deny path is captured
    separately via the synthetic deny output that the route surfaces
    in the SSE stream). `skipped` = the route didn't pass `permissions`
    at all (legacy callers).

Root chat-turn spans (`startRootTurnSpan`):
  - `chemclaw.trace_id`, `chemclaw.user`, `user.id`, `llm.model`,
    `session.id`, `langfuse.session.id`, `langfuse.trace.tags`
    (`prompt:agent.system`, `prompt_version:N`).

## 3. Permission decision tag (BACKLOG'd, now resolved)

`permission.decision` was BACKLOG'd from prior audits because the
resolver result wasn't surfaced on any span. Threading the decision
into `withToolSpan` is a 12-line change in `step.ts` plus an additive
field on `ToolSpanAttributes`. Implemented in:

  - `services/agent-claw/src/observability/tool-spans.ts` —
    `permissionDecision` / `permissionReason` fields on the attributes
    interface; conditionally set on the active span.
  - `services/agent-claw/src/core/step.ts` — capture the resolver
    outcome inside `_runOneTool`, pass it down to `withToolSpan`.

Behaviour preserved: when the route doesn't pass `permissions`, the
tag value is `"skipped"` and the resolver isn't invoked.

## 4. Projector request_id propagation

`services/projectors/common/base.py` already extracted `request_id`
from `payload.request_id` and stamped it onto a `LoggerAdapter` for
the per-event `_process_row` log lines. Gap: subclass code inside
`handle()` that uses `logging.getLogger(__name__)` (the common
pattern in `kg_documents`, `kg_experiments`, `qm_kg`, etc.) emitted
records WITHOUT the correlation fields — the LoggerAdapter only
stamps the records routed through itself.

Fix: bind the same fields to a `contextvars.ContextVar` via
`services.mcp_tools.common.log_context.log_context_scope(...)` so the
`LogContextFilter` (already installed by every projector's
`configure_logging` call) copies `request_id` / `event_id` /
`projector` onto every record emitted in the scope, regardless of
which logger produced it.

The `log_context_scope` import is wrapped in a try/except → `nullcontext`
so projector containers without the `services.mcp_tools.common`
package on PYTHONPATH (we found none in current builds, but the
fallback keeps the projector usable in unit-test isolation) still run.

## 5. error_events write path

`record_error_event(p_service, p_error_code, p_severity, p_payload)` is
the gated INSERT path in `db/init/19_observability.sql` — SECURITY
DEFINER, GRANT EXECUTE limited to `chemclaw_app` + `chemclaw_service`,
PUBLIC revoked. `notify_error_event` AFTER trigger fires
`pg_notify('error_events', …)` so a future tail subscriber can ship
in real time.

Audit finding: **no production caller invokes `record_error_event`
today** (greps in `services/`, `services/agent-claw/src`,
`services/optimizer/`, `services/projectors/` show only the comment
references in `errors/envelope.ts`, `errors/codes.ts`, the Python
`error_codes.py`, and the SQL migration itself). The audit_row_change
trigger in 19_observability.sql writes to error_events on its own
exception path, but no application code does. This is a documented
deferral (cluster-6 in the 2026-05-03 deep-review); flagging here for
A20 visibility — not in scope to fix today since the wiring is a
fleet-wide rollout.

## 6. LOG_USER_SALT enforcement

`assertLogUserSaltConfigured()` is called from `loadConfig()`
(services/agent-claw/src/config.ts:261) so a misconfigured
production deploy fails fast at boot rather than on first
`hashUser()` invocation. PR #96 fix verified intact.

## 7. Files touched

  - `services/agent-claw/src/observability/tool-spans.ts` —
    `permission.decision` / `permission.reason` attributes.
  - `services/agent-claw/src/core/step.ts` — capture resolver
    decision, thread into `withToolSpan`.
  - `services/agent-claw/src/routes/chat.ts` — wrap streaming
    `runHarness` in `otelContext.with(turnCtx, …)`.
  - `services/agent-claw/src/routes/plan.ts` — open root span +
    wrap `runHarness` in `otelContext.with`.
  - `services/agent-claw/src/routes/deep-research.ts` — open root
    span + wrap both `runHarness` calls in `otelContext.with`.
  - `services/agent-claw/src/core/chained-harness.ts` — open
    per-iteration root span; wrap `runHarness` in
    `otelContext.with`.
  - `services/agent-claw/src/core/sub-agent.ts` — open sub-agent
    root span; wrap `runHarness` in `otelContext.with`.
  - `services/projectors/common/base.py` — bind `request_id` /
    `event_id` / `projector` onto a contextvar so subclass
    `handle()` loggers inherit the binding.

## 8. Verification

  - `npx tsc --noEmit -p services/agent-claw` — clean.
  - `services/agent-claw npm test` — 1103 tests pass (146 files).
    Targeted suites covering touched paths:
      - `tests/unit/observability-spans.test.ts` — 10 pass.
      - `tests/unit/otel-spans.test.ts` — 7 pass.
      - `tests/unit/sub-agent.test.ts` — 10 pass.
      - `tests/unit/hooks-redact-secrets.test.ts` — 16 pass.
      - `tests/unit/hook-loader.test.ts` + `hook-loader-coverage.test.ts`
        — 14 pass.

## 9. Deferrals

  - `record_error_event` is unwired in production code paths.
    Backfill is a fleet-wide change (every error envelope writer
    needs to call the function before / instead of returning the
    JSON); deferred to A20 / a follow-up "error_events rollout"
    initiative.
  - Grafana `infra/grafana/provisioning/dashboards/projectors.json`
    not modified — A20 owns dashboard surfaces.
  - Langfuse provider abstraction not addressed (out of scope).
