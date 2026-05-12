// Phase A2 — reflection-prompt builder unit tests.

import { describe, it, expect } from "vitest";
import { buildReflectionPrompt } from "../../src/core/reflection-prompt.js";
import { LOOP_WARNINGS_KEY, type LoopWarning } from "../../src/core/hooks/loop-detector.js";
import type { ToolContext } from "../../src/core/types.js";
import type { Todo } from "../../src/core/session-store.js";

function makeCtx(loopWarnings?: LoopWarning[]): ToolContext {
  const sp = new Map<string, unknown>();
  if (loopWarnings) sp.set(LOOP_WARNINGS_KEY, loopWarnings);
  return {
    userEntraId: "u",
    scratchpad: sp,
    seenFactIds: new Set<string>(),
  };
}

function todo(content: string, status: Todo["status"] = "pending", ordering = 1): Todo {
  return {
    id: "x",
    ordering,
    content,
    status,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("buildReflectionPrompt", () => {
  it("returns null on clean stop", () => {
    expect(
      buildReflectionPrompt({
        ctx: makeCtx(),
        openTodos: [],
        previousFinishReason: "stop",
      }),
    ).toBeNull();
  });

  it("returns a prompt on max_steps", () => {
    const out = buildReflectionPrompt({
      ctx: makeCtx(),
      openTodos: [],
      previousFinishReason: "max_steps",
    });
    expect(out).toContain("REFLECT");
  });

  it("returns a prompt on wall_clock_expired", () => {
    const out = buildReflectionPrompt({
      ctx: makeCtx(),
      openTodos: [],
      previousFinishReason: "wall_clock_expired",
    });
    expect(out).toContain("REFLECT");
  });

  it("surfaces loop warnings", () => {
    const out = buildReflectionPrompt({
      ctx: makeCtx([
        {
          toolId: "query_kg",
          argsHash: "abc",
          occurrences: 4,
          firstSeen: "2026-05-09T00:00:00Z",
          lastSeen: "2026-05-09T00:01:00Z",
        },
      ]),
      openTodos: [],
      previousFinishReason: "max_steps",
    });
    expect(out).toContain("LOOP WARNINGS");
    expect(out).toContain("query_kg");
    expect(out).toContain("×4");
  });

  it("lists open todos and excludes completed", () => {
    const out = buildReflectionPrompt({
      ctx: makeCtx(),
      openTodos: [
        todo("alpha", "pending", 1),
        todo("beta", "in_progress", 2),
        todo("gamma", "completed", 3),
      ],
      previousFinishReason: "max_steps",
    });
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).not.toContain("gamma");
  });

  it("instructs the model on next-action choices including manage_plan + ask_user", () => {
    const out = buildReflectionPrompt({
      ctx: makeCtx(),
      openTodos: [],
      previousFinishReason: "max_steps",
    });
    expect(out).toContain("manage_plan");
    expect(out).toContain("ask_user");
  });
});
