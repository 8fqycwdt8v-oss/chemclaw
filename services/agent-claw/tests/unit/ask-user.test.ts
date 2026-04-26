// Tests for the ask_user builtin (clarification-back primitive).

import { describe, it, expect } from "vitest";
import {
  buildAskUserTool,
  AwaitingUserInputError,
} from "../../src/tools/builtins/ask_user.js";
import type { ToolContext } from "../../src/core/types.js";

function makeCtx(): ToolContext {
  return {
    userEntraId: "alice@corp.com",
    seenFactIds: new Set(),
    scratchpad: new Map<string, unknown>(),
  };
}

describe("ask_user", () => {
  it("throws AwaitingUserInputError carrying the question", async () => {
    const tool = buildAskUserTool();
    const ctx = makeCtx();
    await expect(
      tool.execute(ctx, { question: "Should I proceed with X or Y?" }),
    ).rejects.toBeInstanceOf(AwaitingUserInputError);
  });

  it("records the question in scratchpad before throwing", async () => {
    const tool = buildAskUserTool();
    const ctx = makeCtx();
    await expect(
      tool.execute(ctx, { question: "Which solvent?" }),
    ).rejects.toThrow();
    expect(ctx.scratchpad.get("awaitingQuestion")).toBe("Which solvent?");
  });

  it("validates the question length", () => {
    const tool = buildAskUserTool();
    const tooLong = "x".repeat(2001);
    const parsed = tool.inputSchema.safeParse({ question: tooLong });
    expect(parsed.success).toBe(false);
  });

  it("rejects empty questions", () => {
    const tool = buildAskUserTool();
    const parsed = tool.inputSchema.safeParse({ question: "" });
    expect(parsed.success).toBe(false);
  });
});
