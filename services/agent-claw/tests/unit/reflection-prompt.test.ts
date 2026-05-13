// Phase A2 — reflection-prompt builder unit tests.

import { describe, it, expect } from "vitest";
import {
  buildReflectionPrompt,
  MAX_REFLECTION_PROMPT_BYTES,
} from "../../src/core/reflection-prompt.js";
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

  it("truncates individual todo content past the per-item char cap", () => {
    const big = "x".repeat(2000);
    const out = buildReflectionPrompt({
      ctx: makeCtx(),
      openTodos: [todo(big, "pending", 1)],
      previousFinishReason: "max_steps",
    });
    expect(out).not.toBeNull();
    // Marker appears, full string does not.
    expect(out!).toContain("…");
    expect(out!).not.toContain(big);
  });

  it("caps the assembled prompt at MAX_REFLECTION_PROMPT_BYTES", () => {
    // 10 todos × big content > 8 KiB even after the per-item cap, so the
    // overall byte cap also fires.
    const big = "x".repeat(500);
    const todos = Array.from({ length: 10 }, (_, i) =>
      todo(big + ` (#${i})`, "pending", i + 1),
    );
    const out = buildReflectionPrompt({
      ctx: makeCtx(),
      openTodos: todos,
      previousFinishReason: "max_steps",
    });
    expect(out).not.toBeNull();
    expect(Buffer.byteLength(out!, "utf8")).toBeLessThanOrEqual(
      MAX_REFLECTION_PROMPT_BYTES,
    );
    expect(out!).toContain("[reflection prompt truncated]");
  });
});
