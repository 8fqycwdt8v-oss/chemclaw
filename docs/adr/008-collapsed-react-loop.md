# ADR 008 — Collapsed ReAct Loop: `runHarness` is the Only Loop

**Status:** Accepted
**Date:** 2026-04-28
**Context:** ChemClaw harness control-plane rebuild — Phase 2 (v1.2.0-harness)

---

## Context

Pre-rebuild, three independent ReAct loops coexisted in `services/agent-claw/`:

1. `core/harness.ts::runHarness` — used by sub-agents, `/feedback`, and
   tests.
2. `routes/chat.ts` — a hand-rolled streaming loop for `/api/chat` that
   talked directly to the LLM provider and emitted SSE events. ~96 LOC.
3. `routes/deep-research.ts` — a third loop for the multi-turn research
   route. ~62 LOC.

`manage_todos` SSE emission was hardcoded inside `chat.ts`, so
`/api/sessions/:id/plan/run` did not stream todo updates even though it
exercised the same builtins. Hook coverage was inconsistent across the
three loops: `chat.ts` ran `pre_turn` and `post_turn` but never
`pre_tool` or `post_tool` for non-streaming tools; `deep-research.ts`
fired none of them. Every cross-cutting feature added to the harness
(matcher gating, decision aggregation, compaction triggers) had to be
duplicated across three sites — drift bait by construction.

---

## Decision

`runHarness` (`services/agent-claw/src/core/harness.ts`) is the only
ReAct loop in the system. Streaming is plumbed via an optional callback:

```ts
export interface StreamSink {
  onSession?(sessionId: string): void;
  onTextDelta?(delta: string): void;
  onToolCall?(toolId: string, name: string, input: unknown): void;
  onToolResult?(toolId: string, result: unknown): void;
  onTodoUpdate?(todos: TodoSnapshot[]): void;
  onAwaitingUserInput?(question: string): void;
  onFinish?(reason: FinishReason, budget: BudgetSummary): void;
}
```

Routes that need to stream (`chat.ts`, `deep-research.ts`,
`/api/sessions/:id/plan/run`, `/api/sessions/:id/resume`) build the
sink with `streaming/sse-sink.ts::makeSseSink(reply, redactionLog)` and
pass it as `runHarness({ streamSink, ... })`. The hand-rolled loops are
deleted.

`manage_todos` and `ask_user` emit through the sink, so every route gets
live progress and pause-for-input behaviour for free.

---

## Rationale

**Why callback-based `StreamSink` instead of `AsyncGenerator<SDKMessage>`
(the Claude Agent SDK pattern)?** Fastify SSE writers are a
callback-friendly target — `reply.raw.write("data: ...\n\n")`. Wrapping
runHarness in an `AsyncGenerator` would just re-wrap into the same SSE
events at the route boundary. The callback shape is a strict subset of
the AsyncGenerator shape, so adopting the SDK's pattern later (if
ChemClaw ever sprouts a non-SSE consumer) is straightforward.

**Why a single loop?** Every hook addition or change in the prior world
had to remember N call sites. The audit found Phase 2's `pre_compact`
work would have had to land in three places to be effective — a
maintenance bug waiting to happen. One loop with a sink callback is
strictly less code (~158 LOC of hand-rolled streaming deleted) and a
strictly larger feature set per route.

**Why keep `runHarness` instead of inverting (have routes own the loop
and call into a shared step)?** Sub-agents, the reanimator, and
`/feedback` already drive `runHarness` directly with no streaming. The
sink-as-optional-input shape lets streaming routes opt in without
forcing the non-streaming consumers to construct a no-op sink.

---

## Consequences

- `chat.ts` dropped ~96 LOC; `deep-research.ts` dropped ~62 LOC. Both
  routes are now thin: parse request → build sink → call `runHarness`.
- Tests that exercised the old streaming loop now exercise `runHarness`
  through the same SSE wire format
  (`tests/integration/chat-streaming-via-harness.test.ts`).
- All hook points fire on every route. The `all-hooks-fire` integration
  test (Phase 1C) pins this so a future regression breaks loudly.
- Disconnect-mid-stream cost: `runHarness` runs to completion even after
  the client closes the SSE connection (the sink callbacks become
  no-ops). For long-running harness turns this is wasted compute. The
  fix is to plumb an `AbortController` through `runHarness` and signal
  on `reply.raw` close — deferred follow-up; the cost is bounded by the
  per-turn token budget, so this is not a runaway risk.
- StreamSink streams text token-by-token via `onTextDelta`. This costs
  a 2× LLM round-trip on text-heavy turns (one for the streamed
  response, one for the eventual return), which is the standard
  cost-correctness trade for live UX. A future optimization can
  capture the streamed text into the assistant message directly.

Related ADRs: 007 (hook system rebuild), 009 (permission/decision
contract), 010 (deferred phases).
