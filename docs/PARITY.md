# ChemClaw <-> Claude Agent SDK parity (v1.2.0-harness)

This tracker enumerates every primitive borrowed (or deliberately not
borrowed) from the Claude Agent SDK and its current ChemClaw status as
of `v1.2.0-harness`. Operators looking to lift `.claude/settings.json`
behaviour into agent-claw should start here.

Legend:

- `implemented` — primitive is live on the production harness path.
- `partial` — primitive is partly there; gap noted in the row.
- `deferred` — primitive is intentionally out of v1.2; v1.3 / v1.4 lands it.
- `deliberate` — primitive is intentionally not adopted; ADR explains.

| Primitive | ChemClaw implementation | Status | Notes |
|---|---|---|---|
| Single ReAct loop | `core/harness.ts` | implemented (Phase 2, ADR 008) | StreamSink callback pattern |
| Hook lifecycle (5 core points) | `lifecycle.ts` + `hooks/*.yaml` | implemented (Phase 1, ADR 007) | `pre_turn`, `pre_tool`, `post_tool`, `pre_compact`, `post_turn`; snake_case names; same semantics |
| Hook lifecycle (extended points) | `session_start`, `session_end`, `user_prompt_submit`, `post_tool_failure`, `post_tool_batch`, `permission_request` (declared), `subagent_start`, `subagent_stop`, `task_created`, `task_completed`, `post_compact` | implemented (Phase 4B) | All 11 valid in YAML `lifecycle:` field |
| Hook decision contract (allow/deny/ask/defer) | `core/hook-output.ts` | implemented (Phase 4A, ADR 009) | `deny>defer>ask>allow` precedence via `mostRestrictive` |
| Hook matchers (regex) | `matcher` field on `Lifecycle.on(...)` | implemented (Phase 4A) | Mechanism is real; no built-in declares one today (they gate inside their handlers). Available for operator-authored YAML hooks. |
| Hook async (fire-and-forget) | `{ async: true }` return | implemented (Phase 4A) | Dispatcher does not await |
| Hook timeouts | per-hook `AbortController`, 60s default | implemented (Phase 4A) | Best-effort abort — cooperative handlers honour the signal |
| `pre_compact` / `post_compact` fire | `core/harness.ts` triggers; `compactor.ts` compacts | implemented (Phase 3) | 60% threshold; manual `/compact` slash |
| Tool annotations + parallel batch | `Tool.annotations.readOnly` | implemented (Phase 5) | 21 builtins annotated readOnly; multi-tool LLM responses run via `Promise.all` when all are readonly |
| MCP auth fail-closed in dev | `mcp_tools/common/auth.py` | implemented (Phase 7) | `MCP_AUTH_DEV_MODE=true` required for unsigned access; default rejects with 401 |
| Sub-agent isolation | `core/sub-agent.ts` | implemented (Phase 1B) | Own `ctx`, own `seenFactIds`; inherits parent lifecycle |
| Session persistence + etag | `db/init/13_agent_sessions.sql` | implemented (pre-rebuild) | RLS audit-verified |
| Auto-resume daemon | `optimizer/session_reanimator/` | implemented (pre-rebuild) | 5-min poll; JWT-scoped resume |
| Permission modes (default/acceptEdits/plan/dontAsk/bypassPermissions) | `core/permissions/resolver.ts` + `core/hooks/permission.ts` | partial (Phase 6 — library landed) | Resolver and `permission` hook are wired into `core/step.ts:120` and exercised by `permission-mode.test.ts` + parity scenario 05. **No production route (`chat.ts`, `sessions.ts`, `deep-research.ts`, `sub-agent.ts`) passes a `permissions` option to `runHarness` today**, so the resolver only fires in tests. Route-level activation deferred to v1.4. |
| `allowedTools` / `disallowedTools` | `core/permissions/resolver.ts` | partial (Phase 6 — library landed) | Resolver consults both fields when called, but (a) no production route passes them, and (b) when called, the LLM is still shown the full tool catalog — the filter only short-circuits AT call time via a synthetic `denied_by_permissions` tool result, not before the prompt is built. SDK-parity claim "filter before LLM sees the list" is aspirational. |
| Workspace boundary validation | `security/workspace-boundary.ts` | partial (Phase 6 — helper landed) | `assertWithinWorkspace` is implemented and unit-tested (`workspace-boundary.test.ts`), but no caller invokes it today (no filesystem-shaped tool exists in the catalog). When such a tool is added the author must wire the helper explicitly; no automatic gating wraps tool registration. |
| Etag conflict integration test | `tests/integration/etag-conflict.test.ts` | implemented (Phase 8) | Testcontainer-backed; uses `tests/helpers/postgres-container.ts`. |
| Chained execution integration test | `tests/integration/chained-execution.test.ts` | implemented (Phase 8) | Testcontainer-backed; verifies chained `/api/sessions/:id/plan/run` honours the per-session token budget. |
| Reanimator round-trip integration test | `tests/integration/reanimator-roundtrip.test.ts` | implemented (Phase 8) | Testcontainer-backed; stalled todo → POST `/api/internal/sessions/:id/resume` round-trip. |
| Per-hook + per-tool Langfuse spans | `observability/hook-spans.ts` + `observability/tool-spans.ts` | implemented (Phase 9) | Decorates hook dispatch (`lifecycle.ts:169`) and tool invocation (`step.ts:193`). Hook spans tag `hook.point`, `hook.name`, `hook.matcher_target`, `hook.tool_use_id`, `hook.duration_ms`. Tool spans tag `tool.id`, `tool.read_only`, `tool.in_batch`, `tool.duration_ms`. **`permission.decision` is NOT currently emitted** — would require wiring the resolver result into the active span. Tested in `observability-spans.test.ts`. |
| Mock parity harness (scripted scenarios) | `tests/parity/runner.ts` + `tests/parity/scenarios/*.json` | implemented (Phase 11) | 8 scenarios pinning SSE wire format and final state for canonical agent flows. Run via `tests/parity/parity.test.ts`. |
| Setting sources (user/project/local) | not implemented | deferred (v1.4+) | |
| ToolSearch (lazy tool loading) | not implemented | deferred (v1.4+) | |
| Slash command DSL | partial in `core/slash.ts` | partial | `/plan`, `/compact`, `/eval`, `/feedback`, `/skills` supported |
| Streamed text token-by-token | `StreamSink.onTextDelta` | implemented (Phase 2A) | 2x LLM round-trip on text turns; cost-correct refactor pending (ADR 008) |
| Effort levels (low/medium/high/xhigh/max) | not implemented | deferred (v1.4+) | LiteLLM doesn't expose this primitive uniformly |
| `AsyncGenerator query()` | not adopted | deliberate | Fastify SSE writers - see ADR 008 |

## Read-this-first for reviewers

1. ADR 007 — hook system rebuild (YAML loader as single source of truth).
2. ADR 008 — collapsed ReAct loop (`runHarness` is the only loop).
3. ADR 009 — permission and decision contract.
4. ADR 010 — deferred phases retrospective + remaining v1.4 deferrals.

## Testing

Pinned by:

- `tests/integration/all-hooks-fire.test.ts` — every advertised hook
  point fires on the production harness path.
- `tests/integration/chat-streaming-via-harness.test.ts` — `/api/chat`
  SSE wire format matches what `runHarness` produces directly.
- `tests/integration/pre-compact-end-to-end.test.ts` — `pre_compact`
  fires when the budget threshold is crossed; `post_compact` fires
  after the compactor returns.
- `tests/integration/etag-conflict.test.ts`,
  `tests/integration/chained-execution.test.ts`,
  `tests/integration/reanimator-roundtrip.test.ts` —
  testcontainer-driven session-layer integration suite (Phase 8).
- `tests/parity/parity.test.ts` — 8 scenario JSON files replayed
  through the agent to pin SSE wire-format parity (Phase 11).
- `tests/unit/lifecycle-matchers.test.ts`,
  `tests/unit/lifecycle-decisions.test.ts` — hook matcher and
  decision-aggregation rules (the latter also asserts a never-resolving
  hook is timed out within its configured window).
- `tests/unit/permission-mode.test.ts`,
  `tests/unit/workspace-boundary.test.ts` — Phase 6 resolver +
  filesystem boundary.
- `tests/unit/observability-spans.test.ts` — Phase 9 hook + tool spans.
- `services/mcp_tools/common/tests/test_auth.py` — MCP auth fail-closed.
