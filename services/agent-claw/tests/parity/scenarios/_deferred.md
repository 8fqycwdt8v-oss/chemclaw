# Deferred parity scenarios

Two scenarios from the original Phase 11 commit (c0c949e on the claw-code
branch) cannot run unmodified on the `feat/phases-6-8-9-11` branch
because they assume harness phases that have not been cherry-picked yet.
They are tracked here so they can be re-introduced once the missing
phases land.

## 07 — `parallel-readonly-batch`

**Original premise**: LLM emits a multi-tool batch (`tool_calls` plural).
When every tool in the batch is read-only, the harness fans them out
via `Promise.all`; `pre_tool` / `post_tool` fire per tool, and a single
`post_tool_batch` event fires for the whole batch.

**Why deferred**:
- `StubLlmProvider` on this branch has no `enqueueToolCalls` (plural)
  helper — only `enqueueToolCall` (singular).
- `StepResult` is `{ kind: "tool_call"; toolId; input }`. There is no
  parallel-batch shape.
- `step.ts` executes one tool per step; the `post_tool_batch` hook
  point doesn't exist (the lifecycle's `HookPoint` union has only
  `pre_turn | pre_tool | post_tool | pre_compact | post_turn |
  permission_request`).

**Re-add when**: Phase 5's parallel-readonly-batch ships on this branch
(commit `7b25e30` and follow-ups on the `claw-code` branch).

## 08 — `pre-compact-fires`

**Original premise**: When prompt usage crosses 60% of `maxPromptTokens`
mid-loop, the harness dispatches `pre_compact` + `post_compact` between
the tool round and the final text response.

**Why deferred**:
- `runHarness` does not currently dispatch `pre_compact` or
  `post_compact` from the loop. `HookPoint` includes `pre_compact`, but
  the harness never fires it on this branch — only `compact-window` is
  registered against the point and there is no caller in `harness.ts`
  or `step.ts`.
- The `step_usage_overrides` mechanism (per-step usage shimmed through
  `enqueueText` / `enqueueToolCall` to deterministically trip the
  threshold) does not exist on this branch's `StubLlmProvider`.

**Re-add when**: Phase 8's mid-loop compaction dispatch lands (the
`compact-window` invocation moves from a stub registrar to a real
trigger inside the harness loop).
