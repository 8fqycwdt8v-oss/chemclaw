// Tests that the Phase 4B extended hook points actually dispatch from
// their advertised call sites. The 6 covered here:
//
//   - user_prompt_submit (chat route — covered by routes/chat.test.ts; not
//     re-tested here because it would require a full Fastify stack)
//   - task_created       (manage_todos.create)
//   - task_completed     (manage_todos.complete and manage_todos.update)
//   - subagent_start     (spawnSubAgent before the sub-harness runs)
//   - subagent_stop      (spawnSubAgent after the sub-harness returns)
//   - post_tool_failure  (step.ts when a tool throws)
//
// Approach: drive each dispatch site with stubbed deps and a real Lifecycle
// whose `dispatch` is spied on. Asserts the dispatch spy saw the named hook
// point with a sensible payload. Keeps each test focused on one site so a
// regression in any single dispatch is immediately localised.
//
// This closes the test gap noted in the v1.2.0-harness review: Phase 4B
// added 10 new hook points but only 4 had unit-level dispatch coverage.

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { QueryResult } from "pg";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { Budget } from "../../src/core/budget.js";
import { runHarness } from "../../src/core/harness.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { defineTool } from "../../src/tools/tool.js";
import { buildManageTodosTool } from "../../src/tools/builtins/manage_todos.js";
import { spawnSubAgent } from "../../src/core/sub-agent.js";
import { createMockPool } from "../helpers/mock-pool.js";
import type { Message, ToolContext } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(sessionId = "11111111-1111-1111-1111-111111111111"): ToolContext {
  const scratchpad = new Map<string, unknown>();
  scratchpad.set("session_id", sessionId);
  return {
    userEntraId: "alice@corp.com",
    seenFactIds: new Set(),
    scratchpad,
  };
}

function todoRow(t: {
  id: string;
  ordering: number;
  content: string;
  status: string;
}) {
  const now = new Date();
  return { ...t, created_at: now, updated_at: now };
}

// ---------------------------------------------------------------------------
// task_created / task_completed (manage_todos)
// ---------------------------------------------------------------------------

describe("extended hooks — task_created / task_completed", () => {
  it("manage_todos.create dispatches task_created once per inserted row", async () => {
    const inserted = [
      { id: "t1", ordering: 1, content: "Step 1", status: "pending" },
      { id: "t2", ordering: 2, content: "Step 2", status: "pending" },
    ];

    let listCalls = 0;
    const { pool } = createMockPool({
      dataHandler: async (sql) => {
        if (sql.includes("MAX(ordering)")) {
          return { rows: [{ max: 0 }], rowCount: 1 } as unknown as QueryResult;
        }
        if (sql.includes("INSERT INTO agent_todos")) {
          // session-store inserts in a single statement; return all rows.
          return {
            rows: inserted.map(todoRow),
            rowCount: inserted.length,
          } as unknown as QueryResult;
        }
        if (sql.includes("FROM agent_todos") && sql.includes("WHERE session_id")) {
          listCalls++;
          // First listTodos (before-insert) returns empty; second returns
          // the inserted rows. Drives the freshly-inserted-id detection.
          const rows = listCalls === 1 ? [] : inserted.map(todoRow);
          return {
            rows,
            rowCount: rows.length,
          } as unknown as QueryResult;
        }
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      },
    });

    const lifecycle = new Lifecycle();
    const dispatchSpy = vi.spyOn(lifecycle, "dispatch");

    const ctx: ToolContext = { ...makeCtx(), lifecycle };
    const tool = buildManageTodosTool(pool);
    await tool.execute(ctx, {
      action: "create",
      contents: ["Step 1", "Step 2"],
    });

    const created = dispatchSpy.mock.calls.filter(
      (c) => c[0] === "task_created",
    );
    expect(created).toHaveLength(2);
    const todoIds = created
      .map((c) => (c[1] as { todoId: string }).todoId)
      .sort();
    expect(todoIds).toEqual(["t1", "t2"]);
  });

  it("manage_todos.complete dispatches task_completed", async () => {
    const updated = {
      id: "t1",
      ordering: 1,
      content: "Step 1",
      status: "completed",
    };
    const { pool } = createMockPool({
      dataHandler: async (sql) => {
        if (sql.includes("UPDATE agent_todos")) {
          return {
            rows: [todoRow(updated)],
            rowCount: 1,
          } as unknown as QueryResult;
        }
        if (sql.includes("FROM agent_todos")) {
          return {
            rows: [todoRow(updated)],
            rowCount: 1,
          } as unknown as QueryResult;
        }
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      },
    });

    const lifecycle = new Lifecycle();
    const dispatchSpy = vi.spyOn(lifecycle, "dispatch");

    const ctx: ToolContext = { ...makeCtx(), lifecycle };
    const tool = buildManageTodosTool(pool);
    await tool.execute(ctx, {
      action: "complete",
      todo_id: "00000000-0000-0000-0000-000000000001",
    });

    const completed = dispatchSpy.mock.calls.filter(
      (c) => c[0] === "task_completed",
    );
    expect(completed).toHaveLength(1);
    expect((completed[0]![1] as { todoId: string }).todoId).toBe("t1");
  });

  it("manage_todos.update with status='completed' dispatches task_completed", async () => {
    const updated = {
      id: "t2",
      ordering: 2,
      content: "Step 2",
      status: "completed",
    };
    const { pool } = createMockPool({
      dataHandler: async (sql) => {
        if (sql.includes("UPDATE agent_todos")) {
          return {
            rows: [todoRow(updated)],
            rowCount: 1,
          } as unknown as QueryResult;
        }
        if (sql.includes("FROM agent_todos")) {
          return {
            rows: [todoRow(updated)],
            rowCount: 1,
          } as unknown as QueryResult;
        }
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      },
    });

    const lifecycle = new Lifecycle();
    const dispatchSpy = vi.spyOn(lifecycle, "dispatch");

    const ctx: ToolContext = { ...makeCtx(), lifecycle };
    const tool = buildManageTodosTool(pool);
    await tool.execute(ctx, {
      action: "update",
      todo_id: "00000000-0000-0000-0000-000000000002",
      status: "completed",
    });

    const completed = dispatchSpy.mock.calls.filter(
      (c) => c[0] === "task_completed",
    );
    expect(completed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// subagent_start / subagent_stop (spawnSubAgent)
// ---------------------------------------------------------------------------

describe("extended hooks — subagent_start / subagent_stop", () => {
  it("spawnSubAgent dispatches subagent_start before the sub-harness runs", async () => {
    const lifecycle = new Lifecycle();
    const dispatchSpy = vi.spyOn(lifecycle, "dispatch");

    // Stub LLM that returns a single text step so the sub-harness exits cleanly.
    const llm = new StubLlmProvider().enqueueText("sub-agent done");

    const result = await spawnSubAgent(
      "reader",
      { goal: "summarise", inputs: {} },
      makeCtx(),
      { allTools: [], llm, lifecycle },
    );

    expect(result.finishReason).toBe("stop");

    const starts = dispatchSpy.mock.calls.filter(
      (c) => c[0] === "subagent_start",
    );
    const stops = dispatchSpy.mock.calls.filter(
      (c) => c[0] === "subagent_stop",
    );
    expect(starts).toHaveLength(1);
    expect((starts[0]![1] as { type: string }).type).toBe("reader");
    expect(stops).toHaveLength(1);
    expect((stops[0]![1] as { type: string }).type).toBe("reader");
  });

  it("spawnSubAgent still dispatches subagent_stop on the failure path", async () => {
    const lifecycle = new Lifecycle();
    const dispatchSpy = vi.spyOn(lifecycle, "dispatch");

    // LLM that throws on the first call to simulate a failure inside the
    // sub-harness. spawnSubAgent's try/catch should fire subagent_stop and
    // return a failure result rather than throw.
    const llm = new StubLlmProvider();
    vi.spyOn(llm, "call").mockRejectedValue(new Error("upstream blew up"));

    const result = await spawnSubAgent(
      "analyst",
      { goal: "investigate", inputs: {} },
      makeCtx(),
      { allTools: [], llm, lifecycle },
    );

    expect(result.finishReason).toBe("error");

    const stops = dispatchSpy.mock.calls.filter(
      (c) => c[0] === "subagent_stop",
    );
    expect(stops).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// post_tool_failure (step.ts)
// ---------------------------------------------------------------------------

describe("extended hooks — post_tool_failure", () => {
  it("a tool that throws causes post_tool_failure to dispatch with the error", async () => {
    const boomTool = defineTool({
      id: "boom",
      description: "Always throws.",
      inputSchema: z.object({}).passthrough(),
      outputSchema: z.object({ ok: z.literal(true) }),
      execute: async () => {
        throw new Error("boom from boom");
      },
    });

    const llm = new StubLlmProvider().enqueueToolCall("boom", {});

    const lifecycle = new Lifecycle();
    const dispatchSpy = vi.spyOn(lifecycle, "dispatch");

    const messages: Message[] = [{ role: "user", content: "go" }];

    await expect(
      runHarness({
        messages,
        tools: [boomTool],
        llm,
        budget: new Budget({ maxSteps: 3 }),
        lifecycle,
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/boom from boom/);

    const failures = dispatchSpy.mock.calls.filter(
      (c) => c[0] === "post_tool_failure",
    );
    expect(failures).toHaveLength(1);
    const payload = failures[0]![1] as { toolId: string; error: Error };
    expect(payload.toolId).toBe("boom");
    expect(payload.error.message).toMatch(/boom from boom/);
  });
});

// ---------------------------------------------------------------------------
// user_prompt_submit (chat route)
// ---------------------------------------------------------------------------
//
// Asserted indirectly: the chat route dispatches user_prompt_submit at
// services/agent-claw/src/routes/chat.ts:419. A full integration test
// would need the entire Fastify stack + DB + LLM mocks. The existing
// chat-route tests already exercise this path (`tests/integration/...`)
// and assert overall flow; this file focuses on the dispatch sites that
// previously had zero direct test coverage.
