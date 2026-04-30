// Post-session-review regression test: chat-plan-mode.ts must NOT
// invoke `cleanupSkillForTurn` itself — the caller's outer finally
// in chat.ts owns the call. Pre-fix, the helper called it AND the
// outer finally called it, producing a redundant double-decrement
// that only worked because SkillLoader.enableForTurn happens to be
// idempotent. Tightened up after the post-session review caught it.

import { describe, it, expect, vi } from "vitest";
import { runPlanModeStreaming } from "../../src/routes/chat-plan-mode.js";
import { context as otelContext } from "@opentelemetry/api";
import type { LlmProvider } from "../../src/llm/provider.js";
import type { Message } from "../../src/core/types.js";

describe("chat-plan-mode — cleanupSkillForTurn is caller-owned", () => {
  it("does not invoke cleanupSkillForTurn from inside the helper", async () => {
    const cleanup = vi.fn();
    const fakeReply = {
      raw: {
        end: vi.fn(),
        write: vi.fn(),
        writableEnded: false,
      },
    };
    const fakeReq = {
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    };
    const fakeLlm: LlmProvider = {
      call: vi.fn(),
      stream: vi.fn(),
      // Returns an empty plan steps array → exit success path.
      completeJson: vi.fn().mockResolvedValue({ steps: [] }),
    };
    const messages: Message[] = [{ role: "user", content: "hi" }];

    const finishReason = await runPlanModeStreaming(
      fakeReq as never,
      fakeReply as never,
      {
        llm: fakeLlm,
        pool: {} as never,
        systemPrompt: "sys",
        lastUserContent: "hi",
        messages,
        user: "u@x",
        sessionId: null,
        conn: { closed: false },
        turnCtx: otelContext.active(),
        signal: new AbortController().signal,
        cleanupSkillForTurn: cleanup,
      },
    );

    // Helper succeeded.
    expect(finishReason).toBe("plan_ready");
    // The contract: cleanupSkillForTurn is NOT called by the helper.
    // The caller's outer finally in chat.ts owns the call.
    expect(cleanup).not.toHaveBeenCalled();
    // reply.raw.end() IS still called by the helper — that's a different
    // contract (preventing double-emit of `finish` from the outer finally).
    expect(fakeReply.raw.end).toHaveBeenCalledTimes(1);
  });

  it("does not invoke cleanupSkillForTurn even on the catch path", async () => {
    const cleanup = vi.fn();
    const fakeReply = { raw: { end: vi.fn(), write: vi.fn(), writableEnded: false } };
    const fakeReq = {
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    };
    const fakeLlm: LlmProvider = {
      call: vi.fn(),
      stream: vi.fn(),
      // Throw to take the catch arm.
      completeJson: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const messages: Message[] = [{ role: "user", content: "hi" }];

    const finishReason = await runPlanModeStreaming(
      fakeReq as never,
      fakeReply as never,
      {
        llm: fakeLlm,
        pool: {} as never,
        systemPrompt: "sys",
        lastUserContent: "hi",
        messages,
        user: "u@x",
        sessionId: null,
        conn: { closed: false },
        turnCtx: otelContext.active(),
        signal: new AbortController().signal,
        cleanupSkillForTurn: cleanup,
      },
    );

    // Helper failed — finishReason stays undefined per the contract.
    expect(finishReason).toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();
    expect(fakeReply.raw.end).toHaveBeenCalledTimes(1);
  });
});
