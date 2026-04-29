// manage_todos — Claude-Code TodoWrite analog for Claw Code.
//
// The LLM uses this tool at the start of any multi-step task to write a
// checklist, then updates each todo's status as work progresses. Every
// successful call emits a `todo_update` SSE event (wired in routes/chat.ts
// via a post_tool hook) so the user's UI renders the live progress.
//
// Persistence: agent_todos table (RLS-scoped via the parent agent_sessions
// row's user_entra_id). Requires session_id in ctx.scratchpad (set by the
// chat route at the start of every turn). If session_id is missing the tool
// returns a structured error so the LLM doesn't try to use it.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import {
  createTodos,
  listTodos,
  updateTodo,
  type TodoStatus,
} from "../../core/session-store.js";

// ---------- Schemas ----------------------------------------------------------

const TodoStatusEnum = z.enum(["pending", "in_progress", "completed", "cancelled"]);

export const ManageTodosIn = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    contents: z.array(z.string().min(1).max(1000)).min(1).max(50),
  }),
  z.object({
    action: z.literal("update"),
    todo_id: z.string().uuid(),
    status: TodoStatusEnum.optional(),
    content: z.string().min(1).max(1000).optional(),
  }),
  z.object({
    action: z.literal("complete"),
    todo_id: z.string().uuid(),
  }),
  z.object({
    action: z.literal("cancel"),
    todo_id: z.string().uuid(),
  }),
  z.object({
    action: z.literal("list"),
  }),
]);
export type ManageTodosInput = z.infer<typeof ManageTodosIn>;

const TodoOut = z.object({
  id: z.string(),
  ordering: z.number(),
  content: z.string(),
  status: TodoStatusEnum,
});

export const ManageTodosOut = z.object({
  // Always returns the full updated list so the LLM's next message sees it.
  todos: z.array(TodoOut),
  // Reason field present only on no-op / error cases (still 200 — the model
  // reads the reason and decides next action).
  notice: z.string().optional(),
});
export type ManageTodosOutput = z.infer<typeof ManageTodosOut>;

// ---------- Factory ----------------------------------------------------------

const DESCRIPTION = [
  "Manage a per-session checklist of tasks. Use this for any multi-step plan",
  "(3+ steps). Workflow:",
  "  1. Call action='create' with the full list of steps as `contents`.",
  "  2. Before starting each step, call action='update' with status='in_progress'.",
  "  3. Immediately after finishing, call action='complete'.",
  "  4. Use action='cancel' if a step becomes irrelevant. Use action='list' to inspect.",
  "Each call returns the full updated todos array — the user's UI renders it",
  "live so progress is visible.",
].join(" ");

export function buildManageTodosTool(pool: Pool) {
  return defineTool({
    id: "manage_todos",
    description: DESCRIPTION,
    inputSchema: ManageTodosIn,
    outputSchema: ManageTodosOut,

    execute: async (ctx, input) => {
      const sessionId = ctx.scratchpad.get("session_id");
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        // Throw rather than return a "successful" empty list — otherwise
        // the LLM may interpret todos.length===0 as "no todos exist" and
        // proceed as if it had created the checklist. A typed error
        // surfaces in the harness as a tool failure, which the model
        // handles by adapting (typically: skip the checklist + carry on).
        throw new Error(
          "manage_todos requires an active session_id in scratchpad. " +
            "If you intended to operate without state, do not call this tool.",
        );
      }

      switch (input.action) {
        case "create": {
          // listTodos before-and-after lets us identify the rows that were
          // freshly inserted (by id) without changing createTodos's
          // bulk-insert signature. The fresh rows are then surfaced via
          // task_created so observability hooks can record per-todo events.
          const before = await listTodos(pool, ctx.userEntraId, sessionId);
          const beforeIds = new Set(before.map((t) => t.id));
          await createTodos(pool, ctx.userEntraId, sessionId, input.contents);
          const all = await listTodos(pool, ctx.userEntraId, sessionId);
          if (ctx.lifecycle) {
            for (const t of all) {
              if (!beforeIds.has(t.id)) {
                await ctx.lifecycle.dispatch("task_created", {
                  ctx,
                  todoId: t.id,
                  content: t.content,
                  ordering: t.ordering,
                });
              }
            }
          }
          return { todos: all.map(stripDates) };
        }

        case "update": {
          const patch: { status?: TodoStatus; content?: string } = {};
          if (input.status) patch.status = input.status;
          if (input.content) patch.content = input.content;
          if (Object.keys(patch).length === 0) {
            return { todos: (await listTodos(pool, ctx.userEntraId, sessionId)).map(stripDates), notice: "no fields to update" };
          }
          const updated = await updateTodo(pool, ctx.userEntraId, input.todo_id, patch);
          if (!updated) {
            return {
              todos: (await listTodos(pool, ctx.userEntraId, sessionId)).map(stripDates),
              notice: `todo_id ${input.todo_id} not found`,
            };
          }
          // Dispatch task_completed when the update transitions a todo to
          // status='completed'. The "complete" action below has its own
          // dispatch; this branch covers the model setting status via the
          // generic update verb.
          if (ctx.lifecycle && patch.status === "completed") {
            await ctx.lifecycle.dispatch("task_completed", {
              ctx,
              todoId: updated.id,
              content: updated.content,
            });
          }
          const all = await listTodos(pool, ctx.userEntraId, sessionId);
          return { todos: all.map(stripDates) };
        }

        case "complete": {
          const updated = await updateTodo(pool, ctx.userEntraId, input.todo_id, {
            status: "completed",
          });
          if (!updated) {
            return {
              todos: (await listTodos(pool, ctx.userEntraId, sessionId)).map(stripDates),
              notice: `todo_id ${input.todo_id} not found`,
            };
          }
          if (ctx.lifecycle) {
            await ctx.lifecycle.dispatch("task_completed", {
              ctx,
              todoId: updated.id,
              content: updated.content,
            });
          }
          const all = await listTodos(pool, ctx.userEntraId, sessionId);
          return { todos: all.map(stripDates) };
        }

        case "cancel": {
          const updated = await updateTodo(pool, ctx.userEntraId, input.todo_id, {
            status: "cancelled",
          });
          if (!updated) {
            return {
              todos: (await listTodos(pool, ctx.userEntraId, sessionId)).map(stripDates),
              notice: `todo_id ${input.todo_id} not found`,
            };
          }
          const all = await listTodos(pool, ctx.userEntraId, sessionId);
          return { todos: all.map(stripDates) };
        }

        case "list": {
          const all = await listTodos(pool, ctx.userEntraId, sessionId);
          return { todos: all.map(stripDates) };
        }
      }
    },
  });
}

// Helper: drop Date fields from todos before returning (output schema is
// (id, ordering, content, status) — the LLM doesn't need timestamps).
function stripDates(t: {
  id: string;
  ordering: number;
  content: string;
  status: TodoStatus;
}): { id: string; ordering: number; content: string; status: TodoStatus } {
  return { id: t.id, ordering: t.ordering, content: t.content, status: t.status };
}
