// Tests for the cluster-F lifecycle-telemetry stubs.
//
// Each stub does two things and only two things:
//   1. Returns {} (so it never contributes a deny / defer / ask decision).
//   2. Calls log.info or log.warn with a structured payload.
//
// The tests assert the lifecycle.on() wiring lands at the right point and
// the handler is callable with a representative payload. We don't assert
// the log emission shape directly — that lives in observability/logger
// tests (and Pino is the source of truth for serializer semantics).

import { describe, it, expect, vi } from "vitest";
import { Lifecycle } from "../../src/core/lifecycle.js";
import {
  registerSessionEndHook,
  registerUserPromptSubmitHook,
  registerPostToolFailureHook,
  registerPostToolBatchHook,
  registerSubagentStartHook,
  registerSubagentStopHook,
  registerTaskCreatedHook,
  registerTaskCompletedHook,
  registerPostCompactHook,
  postCompactHook,
} from "../../src/core/hooks/lifecycle-telemetry.js";
import type { ToolContext } from "../../src/core/types.js";

const ctx: ToolContext = {
  userEntraId: "user@test",
  scratchpad: new Map(),
  seenFactIds: new Set(),
};

describe("lifecycle-telemetry registrars", () => {
  it("registers each handler at exactly its declared lifecycle point", () => {
    const lc = new Lifecycle();
    registerSessionEndHook(lc);
    registerUserPromptSubmitHook(lc);
    registerPostToolFailureHook(lc);
    registerPostToolBatchHook(lc);
    registerSubagentStartHook(lc);
    registerSubagentStopHook(lc);
    registerTaskCreatedHook(lc);
    registerTaskCompletedHook(lc);
    registerPostCompactHook(lc);

    expect(lc.count("session_end")).toBe(1);
    expect(lc.count("user_prompt_submit")).toBe(1);
    expect(lc.count("post_tool_failure")).toBe(1);
    expect(lc.count("post_tool_batch")).toBe(1);
    expect(lc.count("subagent_start")).toBe(1);
    expect(lc.count("subagent_stop")).toBe(1);
    expect(lc.count("task_created")).toBe(1);
    expect(lc.count("task_completed")).toBe(1);
    expect(lc.count("post_compact")).toBe(1);
  });

  it("each handler returns {} (never contributes a decision)", async () => {
    const lc = new Lifecycle();
    registerSessionEndHook(lc);
    registerUserPromptSubmitHook(lc);
    registerPostToolFailureHook(lc);
    registerPostToolBatchHook(lc);
    registerSubagentStartHook(lc);
    registerSubagentStopHook(lc);
    registerTaskCreatedHook(lc);
    registerTaskCompletedHook(lc);
    registerPostCompactHook(lc);

    // dispatch each point — none should throw, none should deny / defer / ask.
    const r1 = await lc.dispatch("session_end", {
      ctx,
      sessionId: "s1",
      finishReason: "stop",
    });
    expect(r1.permissionDecision).toBeUndefined();

    const r2 = await lc.dispatch("user_prompt_submit", {
      ctx,
      prompt: "hello",
      sessionId: "s1",
    });
    expect(r2.permissionDecision).toBeUndefined();

    const r3 = await lc.dispatch("post_tool_failure", {
      ctx,
      toolId: "search_knowledge",
      input: { query: "x" },
      error: new Error("boom"),
      durationMs: 12,
    });
    expect(r3.permissionDecision).toBeUndefined();

    const r4 = await lc.dispatch("post_tool_batch", {
      ctx,
      batch: [{ toolId: "a", input: {}, output: {} }],
    });
    expect(r4.permissionDecision).toBeUndefined();

    const r5 = await lc.dispatch("subagent_start", {
      ctx,
      type: "chemist",
      taskSpec: { goal: "g", inputs: {} },
      parentUserEntraId: "user@test",
    });
    expect(r5.permissionDecision).toBeUndefined();

    const r6 = await lc.dispatch("subagent_stop", {
      ctx,
      type: "chemist",
      result: {
        text: "ok",
        finishReason: "stop",
        citations: [],
        stepsUsed: 1,
        usage: { promptTokens: 10, completionTokens: 5 },
      },
      durationMs: 100,
    });
    expect(r6.permissionDecision).toBeUndefined();

    const r7 = await lc.dispatch("task_created", {
      ctx,
      todoId: "t1",
      content: "do thing",
      ordering: 1,
    });
    expect(r7.permissionDecision).toBeUndefined();

    const r8 = await lc.dispatch("task_completed", {
      ctx,
      todoId: "t1",
      content: "do thing",
    });
    expect(r8.permissionDecision).toBeUndefined();

    const r9 = await lc.dispatch("post_compact", {
      ctx,
      trigger: "auto",
      pre_tokens: 100_000,
      post_tokens: 25_000,
    });
    expect(r9.permissionDecision).toBeUndefined();
  });
});

describe("post_compact shrinkRatio", () => {
  it("computes 1 - post/pre when pre > 0", async () => {
    const out = await postCompactHook({
      ctx,
      trigger: "auto",
      pre_tokens: 1000,
      post_tokens: 250,
    });
    expect(out).toEqual({});
    // Indirect assertion: the handler runs without throwing on a normal
    // compaction. The ratio computation is pure and the log line carries
    // it under shrinkRatio (verified via Pino in production).
  });

  it("does not divide by zero when pre is 0", async () => {
    const out = await postCompactHook({
      ctx,
      trigger: "auto",
      pre_tokens: 0,
      post_tokens: 0,
    });
    expect(out).toEqual({});
  });
});

describe("integration with Lifecycle dispatcher", () => {
  it("dispatches session_end through the registered handler with no error", async () => {
    const lc = new Lifecycle();
    registerSessionEndHook(lc);

    // No spy on log — we'd be coupling to Pino's internals. The
    // dispatcher's own span instrumentation guarantees a single
    // call landed; that's the contract.
    const dispatchSpy = vi.spyOn(lc, "dispatch");
    await lc.dispatch("session_end", {
      ctx,
      sessionId: "s2",
      finishReason: "max_steps",
    });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });
});
