// Tests for the manage_todos builtin tool (autonomy upgrade).

import { describe, it, expect } from "vitest";
import type { QueryResult } from "pg";
import type { ToolContext } from "../../src/core/types.js";
import { buildManageTodosTool } from "../../src/tools/builtins/manage_todos.js";
import { createMockPool } from "../helpers/mock-pool.js";

// Manage_todos goes through session-store CRUD which emits a small set of
// SQL shapes. The mock-pool helper handles transaction-control SQL; this
// per-test function provides the data-shape responses.
function makeMockPool(opts: {
  insertedTodos?: Array<{ id: string; ordering: number; content: string; status: string }>;
  listAfter?: Array<{ id: string; ordering: number; content: string; status: string }>;
  updatedTodo?: { id: string; ordering: number; content: string; status: string } | null;
}) {
  const now = new Date();
  return createMockPool({
    dataHandler: async (sql) => {
      if (sql.includes("MAX(ordering)")) {
        return { rows: [{ max: 0 }], rowCount: 1 } as unknown as QueryResult;
      }
      if (sql.includes("INSERT INTO agent_todos")) {
        const inserted = opts.insertedTodos?.shift();
        return {
          rows: inserted ? [{ ...inserted, created_at: now, updated_at: now }] : [],
          rowCount: inserted ? 1 : 0,
        } as unknown as QueryResult;
      }
      if (sql.includes("UPDATE agent_todos")) {
        const updated = opts.updatedTodo;
        return {
          rows: updated ? [{ ...updated, created_at: now, updated_at: now }] : [],
          rowCount: updated ? 1 : 0,
        } as unknown as QueryResult;
      }
      if (sql.includes("FROM agent_todos") && sql.includes("WHERE session_id")) {
        const list = opts.listAfter ?? [];
        return {
          rows: list.map((t) => ({ ...t, created_at: now, updated_at: now })),
          rowCount: list.length,
        } as unknown as QueryResult;
      }
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    },
  });
}

function makeCtx(sessionId: string | null = "11111111-1111-1111-1111-111111111111"): ToolContext {
  const scratchpad = new Map<string, unknown>();
  if (sessionId) scratchpad.set("session_id", sessionId);
  return {
    userEntraId: "alice@corp.com",
    seenFactIds: new Set(),
    scratchpad,
  };
}

describe("manage_todos — create", () => {
  it("returns the full todos array after a create", async () => {
    const inserted = [
      { id: "t1", ordering: 1, content: "Step 1", status: "pending" },
      { id: "t2", ordering: 2, content: "Step 2", status: "pending" },
    ];
    const { pool } = makeMockPool({
      insertedTodos: [...inserted],
      listAfter: inserted,
    });
    const tool = buildManageTodosTool(pool);
    const result = await tool.execute(makeCtx(), {
      action: "create",
      contents: ["Step 1", "Step 2"],
    });
    expect(result.todos).toHaveLength(2);
    expect(result.todos[0]!.content).toBe("Step 1");
    expect(result.todos[0]!.status).toBe("pending");
  });

  it("throws when no session_id is bound", async () => {
    const { pool } = makeMockPool({});
    const tool = buildManageTodosTool(pool);
    await expect(
      tool.execute(makeCtx(null), {
        action: "create",
        contents: ["Lonely step"],
      }),
    ).rejects.toThrow(/active session_id/);
  });
});

describe("manage_todos — update / complete / cancel", () => {
  it("updates a todo's status to in_progress", async () => {
    const updated = { id: "t1", ordering: 1, content: "Step 1", status: "in_progress" };
    const list = [updated];
    const { pool } = makeMockPool({ updatedTodo: updated, listAfter: list });
    const tool = buildManageTodosTool(pool);
    const result = await tool.execute(makeCtx(), {
      action: "update",
      todo_id: "00000000-0000-0000-0000-000000000001",
      status: "in_progress",
    });
    expect(result.todos[0]!.status).toBe("in_progress");
  });

  it("completes a todo via the dedicated action", async () => {
    const updated = { id: "t1", ordering: 1, content: "Step 1", status: "completed" };
    const { pool } = makeMockPool({ updatedTodo: updated, listAfter: [updated] });
    const tool = buildManageTodosTool(pool);
    const result = await tool.execute(makeCtx(), {
      action: "complete",
      todo_id: "00000000-0000-0000-0000-000000000001",
    });
    expect(result.todos[0]!.status).toBe("completed");
  });

  it("returns a notice when the todo_id doesn't exist", async () => {
    const { pool } = makeMockPool({ updatedTodo: null, listAfter: [] });
    const tool = buildManageTodosTool(pool);
    const result = await tool.execute(makeCtx(), {
      action: "complete",
      todo_id: "00000000-0000-0000-0000-000000000099",
    });
    expect(result.notice).toMatch(/not found/);
  });
});

describe("manage_todos — list", () => {
  it("returns the persisted todos", async () => {
    const list = [
      { id: "t1", ordering: 1, content: "A", status: "completed" },
      { id: "t2", ordering: 2, content: "B", status: "in_progress" },
      { id: "t3", ordering: 3, content: "C", status: "pending" },
    ];
    const { pool } = makeMockPool({ listAfter: list });
    const tool = buildManageTodosTool(pool);
    const result = await tool.execute(makeCtx(), { action: "list" });
    expect(result.todos.map((t) => t.status)).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
  });
});
