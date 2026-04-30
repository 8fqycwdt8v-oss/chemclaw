// Audit M11 regression test — the compact-window hook must forward the
// per-dispatch AbortSignal into compact() → completeJson(). Before the fix
// the synopsis call ignored the signal entirely, so a 60s hook timeout (or
// a route-level cancel) couldn't actually stop the in-flight LLM call —
// the fetch would hang to its own LiteLLM-side timeout.

import { describe, it, expect } from "vitest";
import type { LlmProvider, LlmResponse, LlmCallOptions, LlmStreamEvent } from "../../src/llm/provider.js";
import type { Tool } from "../../src/tools/tool.js";
import type { Message, PreCompactPayload, ToolContext } from "../../src/core/types.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { registerCompactWindowHook } from "../../src/core/hooks/compact-window.js";

function buildPayload(): PreCompactPayload {
  const ctx: ToolContext = {
    userEntraId: "u@x",
    seenFactIds: new Set<string>(),
    scratchpad: new Map<string, unknown>(),
    lifecycle: new Lifecycle(),
  };
  // Enough messages to actually invoke compact() rather than no-op.
  const messages: Message[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "next" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "another" },
    { role: "assistant", content: "done" },
  ];
  return {
    ctx,
    messages,
    trigger: "manual",
    pre_tokens: 100,
    custom_instructions: null,
  };
}

class RecordingLlm implements LlmProvider {
  public capturedSignal: AbortSignal | undefined;
  async call(_messages: Message[], _tools: Tool[], _opts?: LlmCallOptions): Promise<LlmResponse> {
    return {
      result: { kind: "text", text: "" },
      usage: { promptTokens: 0, completionTokens: 0 },
      finishReason: "stop",
    };
  }
  async *stream(): AsyncIterable<LlmStreamEvent> { /* not used here */ }
  async completeJson(opts: { system: string; user: string; signal?: AbortSignal }): Promise<unknown> {
    this.capturedSignal = opts.signal;
    return await Promise.resolve({ synopsis: "test summary" });
  }
}

describe("compact-window hook — signal forwarding (M11)", () => {
  it("forwards the per-dispatch AbortSignal into completeJson", async () => {
    const lc = new Lifecycle();
    const llm = new RecordingLlm();
    registerCompactWindowHook(lc, { llm, tokenBudget: 5_000 });

    await lc.dispatch("pre_compact", buildPayload());

    expect(llm.capturedSignal).toBeDefined();
    // Lifecycle.dispatch creates a per-call AbortController; the signal we
    // captured is its `.signal`. It should not have been aborted by the
    // dispatch (no timeout fired in this fast test).
    expect(llm.capturedSignal!.aborted).toBe(false);
  });

  it("aborts the LLM signal when the per-hook timeout fires", async () => {
    const lc = new Lifecycle();

    class SlowLlm extends RecordingLlm {
      override async completeJson(opts: { system: string; user: string; signal?: AbortSignal }): Promise<unknown> {
        this.capturedSignal = opts.signal;
        // Wait for the abort signal — mirrors a real LLM call that respects
        // cancellation. Without the M11 fix this never resolves before the
        // 60s default timeout.
        return await new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
    }

    const slow = new SlowLlm();
    // Bypass the public registerCompactWindowHook helper here so we can
    // pin a tight per-hook timeout (50ms) — the helper hard-codes default.
    // We replicate its body inline.
    lc.on(
      "pre_compact",
      "compact-window",
      async (payload: PreCompactPayload, _toolUseID, options) => {
        const { compact } = await import("../../src/core/compactor.js");
        const compacted = await compact(payload.messages, {
          tokenBudget: 5_000,
          triggerFraction: 0.6,
          recentKeep: 3,
          llm: slow,
          signal: options.signal,
        });
        payload.messages.splice(0, payload.messages.length, ...compacted);
        return {};
      },
      { timeout: 50 },
    );

    // Dispatch and let the 50ms timeout abort the in-flight LLM call.
    await lc.dispatch("pre_compact", buildPayload());

    expect(slow.capturedSignal).toBeDefined();
    expect(slow.capturedSignal!.aborted).toBe(true);
  });
});
