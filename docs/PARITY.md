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
| Hook matchers (regex) | `matcher` field on `Lifecycle.on(...)` | implemented (Phase 4A) | Used today by `source-cache` and `tag-maturity` |
| Hook async (fire-and-forget) | `{ async: true }` return | implemented (Phase 4A) | Dispatcher does not await |
| Hook timeouts | per-hook `AbortController`, 60s default | implemented (Phase 4A) | Best-effort abort — cooperative handlers honour the signal |
| `pre_compact` / `post_compact` fire | `core/harness.ts` triggers; `compactor.ts` compacts | implemented (Phase 3) | 60% threshold; manual `/compact` slash |
| Tool annotations + parallel batch | `Tool.annotations.readOnly` | implemented (Phase 5) | 21 builtins annotated readOnly; multi-tool LLM responses run via `Promise.all` when all are readonly |
| MCP auth fail-closed in dev | `mcp_tools/common/auth.py` | implemented (Phase 7) | `MCP_AUTH_DEV_MODE=true` required for unsigned access; default rejects with 401 |
| Sub-agent isolation | `core/sub-agent.ts` | implemented (Phase 1B) | Own `ctx`, own `seenFactIds`; inherits parent lifecycle |
| Session persistence + etag | `db/init/13_agent_sessions.sql` | implemented (pre-rebuild) | RLS audit-verified |
| Auto-resume daemon | `optimizer/session_reanimator/` | implemented (pre-rebuild) | 5-min poll; JWT-scoped resume |
| Permission modes (default/acceptEdits/plan/dontAsk/bypassPermissions) | not implemented | deferred (Phase 6, v1.3) | Hook contract is in place via ADR 009; route-level resolver pending |
| `allowedTools` / `disallowedTools` | not implemented | deferred (Phase 6, v1.3) | |
| Workspace boundary validation | not implemented | deferred (Phase 6, v1.3) | |
| Etag conflict integration test | not implemented | deferred (Phase 8, v1.3) | Behaviour is correct by inspection; no testcontainer-driven test yet |
| Chained execution integration test | not implemented | deferred (Phase 8, v1.3) | |
| Reanimator round-trip integration test | not implemented | deferred (Phase 8, v1.3) | |
| Per-hook + per-tool Langfuse spans | not implemented | deferred (Phase 9, v1.3) | OTLP exporter is wired; hot-path spans pending |
| Mock parity harness (scripted scenarios) | not implemented | deferred (Phase 11, v1.3) | Pattern documented in plan + ADR 010 |
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
4. ADR 010 — deferred phases (what's NOT in v1.2 and why).

## Testing

Pinned by:

- `tests/integration/all-hooks-fire.test.ts` — every advertised hook
  point fires on the production harness path.
- `tests/integration/chat-streaming-via-harness.test.ts` — `/api/chat`
  SSE wire format matches what `runHarness` produces directly.
- `tests/unit/lifecycle-matchers.test.ts`,
  `tests/unit/lifecycle-decisions.test.ts` — hook matcher and
  decision-aggregation rules (the latter also asserts a never-resolving
  hook is timed out within its configured window).
- `services/mcp_tools/common/tests/test_auth.py` — MCP auth fail-closed.
