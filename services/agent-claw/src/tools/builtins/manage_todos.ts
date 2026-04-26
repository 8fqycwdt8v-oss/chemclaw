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
        // Stateless turn (no session_id). Return a structured no-op so the
        // model can adapt; do not throw — that would abort the tool call.
        return {
          todos: [],
          notice:
            "manage_todos requires an active session — none is bound to this turn. Continue without a checklist.",
        };
      }

      switch (input.action) {
        case "create": {
          await createTodos(pool, ctx.userEntraId, sessionId, input.contents);
          const all = await listTodos(pool, ctx.userEntraId, sessionId);
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
