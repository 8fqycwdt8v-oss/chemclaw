// Tests for hook ordering, dispatch, and abort semantics.

import { describe, it, expect, vi } from "vitest";
import { Lifecycle } from "../../src/core/lifecycle.js";
import type { ToolContext } from "../../src/core/types.js";

function makeCtx(): ToolContext {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

describe("Lifecycle hook dispatcher", () => {
  it("dispatches pre_turn hooks in registration order", async () => {
    const lifecycle = new Lifecycle();
    const order: number[] = [];

    lifecycle.on("pre_turn", "hook-1", async () => { order.push(1); });
    lifecycle.on("pre_turn", "hook-2", async () => { order.push(2); });
    lifecycle.on("pre_turn", "hook-3", async () => { order.push(3); });

    await lifecycle.dispatch("pre_turn", { ctx: makeCtx(), messages: [] });

    expect(order).toEqual([1, 2, 3]);
  });

  it("dispatches post_turn with correct payload shape", async () => {
    const lifecycle = new Lifecycle();
    const receivedPayloads: unknown[] = [];

    lifecycle.on("post_turn", "capture", async (payload) => {
      receivedPayloads.push({ ...payload });
    });

    const ctx = makeCtx();
    await lifecycle.dispatch("post_turn", {
      ctx,
      finalText: "result text",
      stepsUsed: 3,
    });

    expect(receivedPayloads).toHaveLength(1);
    const payload = receivedPayloads[0] as { finalText: string; stepsUsed: number };
    expect(payload.finalText).toBe("result text");
    expect(payload.stepsUsed).toBe(3);
  });

  it("pre_tool hook can abort by throwing", async () => {
    const lifecycle = new Lifecycle();
    const afterSpy = vi.fn();

    lifecycle.on("pre_tool", "guard", async () => {
      throw new Error("tool call aborted by guard");
    });
    // This second hook must NOT be called.
    lifecycle.on("pre_tool", "after-guard", async () => {
      afterSpy();
    });

    const ctx = makeCtx();
    await expect(
      lifecycle.dispatch("pre_tool", { ctx, toolId: "echo", input: {} }),
    ).rejects.toThrow("tool call aborted by guard");

    // Remaining hooks in the sequence are skipped.
    expect(afterSpy).not.toHaveBeenCalled();
  });

  it("pre_tool hook can mutate input in-place", async () => {
    const lifecycle = new Lifecycle();

    lifecycle.on("pre_tool", "mutate-input", async (payload) => {
      // Payload.input is writable — hook rewrites it.
      (payload as { input: unknown }).input = { text: "mutated" };
    });

    const payload = { ctx: makeCtx(), toolId: "echo", input: { text: "original" } };
    await lifecycle.dispatch("pre_tool", payload);

    expect(payload.input).toEqual({ text: "mutated" });
  });

  it("post_tool hook can annotate output in-place", async () => {
    const lifecycle = new Lifecycle();

    lifecycle.on("post_tool", "tag-maturity", async (payload) => {
      (payload as { output: unknown }).output = {
        ...(payload.output as Record<string, unknown>),
        maturity: "EXPLORATORY",
      };
    });

    const payload = {
      ctx: makeCtx(),
      toolId: "echo",
      input: { text: "hi" },
      output: { echoed: "hi" },
    };
    await lifecycle.dispatch("post_tool", payload);

    expect(payload.output).toEqual({ echoed: "hi", maturity: "EXPLORATORY" });
  });

  it("count() returns number of hooks per point", () => {
    const lifecycle = new Lifecycle();
    lifecycle.on("pre_turn", "a", async () => {});
    lifecycle.on("pre_turn", "b", async () => {});
    lifecycle.on("post_turn", "c", async () => {});

    expect(lifecycle.count("pre_turn")).toBe(2);
    expect(lifecycle.count("post_turn")).toBe(1);
    expect(lifecycle.count("pre_tool")).toBe(0);
  });

  it("clear() removes all hooks for a given point", () => {
    const lifecycle = new Lifecycle();
    lifecycle.on("pre_turn", "a", async () => {});
    lifecycle.on("pre_tool", "b", async () => {});

    lifecycle.clear("pre_turn");

    expect(lifecycle.count("pre_turn")).toBe(0);
    expect(lifecycle.count("pre_tool")).toBe(1);
  });

  it("dispatching a point with no hooks is a no-op", async () => {
    const lifecycle = new Lifecycle();
    // Should not throw even with no hooks registered.
    await expect(
      lifecycle.dispatch("pre_compact", { ctx: makeCtx(), messages: [] }),
    ).resolves.toBeUndefined();
  });
});
