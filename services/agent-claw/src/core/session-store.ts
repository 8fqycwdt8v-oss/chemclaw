// Persistent session state for the agent harness.
//
// Backs Claude-Code-like multi-hour autonomy: scratchpad survives across
// /api/chat POSTs so the agent has continuity, todos are checklisted by the
// LLM via manage_todos, and ask_user can pause the loop and resume later.
//
// Storage: agent_sessions + agent_todos (db/init/13_agent_sessions.sql).
// Every read/write goes through withUserContext so RLS gates by user_entra_id.

import type { Pool } from "pg";
import { withUserContext } from "../db/with-user-context.js";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface Todo {
  id: string;
  ordering: number;
  content: string;
  status: TodoStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Why the last harness turn ended. Drives the client's resume logic.
 *
 *   stop                       — model produced a final text response.
 *   max_steps                  — step cap reached; client may re-POST to continue.
 *   budget_exceeded            — per-turn token budget tripped; fresh budget needed.
 *   session_budget_exceeded    — per-session lifetime cap tripped; needs cap bump.
 *   awaiting_user_input        — ask_user fired; client must POST a user message
 *                                carrying the answer to resume.
 *   concurrent_modification    — etag mismatch on save; client should reload + retry.
 *   error                      — uncaught exception; check logs.
 */
export type SessionFinishReason =
  | "stop"
  | "max_steps"
  | "budget_exceeded"
  | "session_budget_exceeded"
  | "awaiting_user_input"
  | "concurrent_modification"
  | "error";

export interface SessionState {
  id: string;
  userEntraId: string;
  scratchpad: Record<string, unknown>;
  lastFinishReason: SessionFinishReason | null;
  awaitingQuestion: string | null;
  messageCount: number;
  todos: Todo[];
  /** Optimistic-concurrency token; regenerated on every UPDATE that
   * mutates user-facing state. saveSession with mismatched expectedEtag
   * raises OptimisticLockError. */
  etag: string;
  // Cross-turn budget accumulation (Phase F). NULL session_token_budget
  // means "fall back to AGENT_SESSION_TOKEN_BUDGET env var".
  sessionInputTokens: number;
  sessionOutputTokens: number;
  sessionSteps: number;
  sessionTokenBudget: number | null;
  // Auto-resume cap (Phase I). reanimator stops when count >= cap.
  autoResumeCount: number;
  autoResumeCap: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

/**
 * Thrown by saveSession when the row's etag has changed since loadSession.
 * Caller should reload + reconcile + retry. Maps to HTTP 409 at the route layer.
 */
export class OptimisticLockError extends Error {
  constructor(sessionId: string) {
    super(`agent_sessions row ${sessionId} was modified concurrently`);
    this.name = "OptimisticLockError";
  }
}

interface SessionRow {
  id: string;
  user_entra_id: string;
  scratchpad: Record<string, unknown>;
  last_finish_reason: SessionFinishReason | null;
  awaiting_question: string | null;
  message_count: number;
  etag: string;
  session_input_tokens: string;  // BIGINT — pg returns string
  session_output_tokens: string;
  session_steps: number;
  session_token_budget: string | null;
  auto_resume_count: number;
  auto_resume_cap: number;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}

interface TodoRow {
  id: string;
  ordering: number;
  content: string;
  status: TodoStatus;
  created_at: Date;
  updated_at: Date;
}

function rowsToTodos(rows: TodoRow[]): Todo[] {
  return rows
    .map((r) => ({
      id: r.id,
      ordering: r.ordering,
      content: r.content,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
    .sort((a, b) => a.ordering - b.ordering);
}

/**
 * Create a fresh session row and return its id. Caller emits the id back
 * to the client (via the `session` SSE event in routes/chat.ts) so the
 * client can supply it on subsequent POSTs to maintain continuity.
 */
export async function createSession(
  pool: Pool,
  userEntraId: string,
): Promise<string> {
  return await withUserContext(pool, userEntraId, async (client) => {
    const r = await client.query<{ id: string }>(
      `INSERT INTO agent_sessions (user_entra_id)
       VALUES ($1)
       RETURNING id::text AS id`,
      [userEntraId],
    );
    const id = r.rows[0]?.id;
    if (!id) {
      throw new Error("createSession: INSERT returned no row");
    }
    return id;
  });
}

/**
 * Load a session by id. RLS gates on user_entra_id so a user can only
 * load their own sessions; returns null if the row doesn't exist or
 * isn't visible.
 */
export async function loadSession(
  pool: Pool,
  userEntraId: string,
  sessionId: string,
): Promise<SessionState | null> {
  return await withUserContext(pool, userEntraId, async (client) => {
    const sessionResult = await client.query<SessionRow>(
      `SELECT id::text AS id,
              user_entra_id,
              scratchpad,
              last_finish_reason,
              awaiting_question,
              message_count,
              etag::text AS etag,
              session_input_tokens,
              session_output_tokens,
              session_steps,
              session_token_budget,
              auto_resume_count,
              auto_resume_cap,
              created_at,
              updated_at,
              expires_at
         FROM agent_sessions
        WHERE id = $1::uuid`,
      [sessionId],
    );
    const row = sessionResult.rows[0];
    if (!row) return null;

    const todosResult = await client.query<TodoRow>(
      `SELECT id::text AS id, ordering, content, status, created_at, updated_at
         FROM agent_todos
        WHERE session_id = $1::uuid
        ORDER BY ordering ASC`,
      [sessionId],
    );

    return {
      id: row.id,
      userEntraId: row.user_entra_id,
      scratchpad: row.scratchpad ?? {},
      lastFinishReason: row.last_finish_reason,
      awaitingQuestion: row.awaiting_question,
      messageCount: row.message_count,
      etag: row.etag,
      sessionInputTokens: Number(row.session_input_tokens),
      sessionOutputTokens: Number(row.session_output_tokens),
      sessionSteps: row.session_steps,
      sessionTokenBudget:
        row.session_token_budget == null ? null : Number(row.session_token_budget),
      autoResumeCount: row.auto_resume_count,
      autoResumeCap: row.auto_resume_cap,
      todos: rowsToTodos(todosResult.rows),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  });
}

/**
 * Persist scratchpad + finish-reason fields back to the session row.
 *
 * Does NOT write todos — those live in agent_todos and are managed by
 * the manage_todos tool directly. Splitting the responsibility keeps
 * post_turn cheap (one UPDATE) and gives manage_todos atomic writes.
 *
 * Scratchpad is JSON-serialized. Non-JSON-safe values (Set, Map, Date)
 * are converted to plain arrays/objects/ISO strings; if a tool stuffed
 * something exotic in there, it'll come back as a plain object.
 */
export async function saveSession(
  pool: Pool,
  userEntraId: string,
  sessionId: string,
  patch: {
    scratchpad?: Record<string, unknown>;
    lastFinishReason?: SessionFinishReason | null;
    awaitingQuestion?: string | null;
    messageCount?: number;
    sessionInputTokens?: number;
    sessionOutputTokens?: number;
    sessionSteps?: number;
    autoResumeCount?: number;
    /** Optimistic-concurrency check: if set, the UPDATE WHERE clause
     * matches on this etag. Mismatch → OptimisticLockError. */
    expectedEtag?: string;
  },
): Promise<{ etag: string }> {
  return await withUserContext(pool, userEntraId, async (client) => {
    // JSON-safe serialization: Sets and Maps don't serialize natively.
    const safeScratch = patch.scratchpad
      ? JSON.parse(
          JSON.stringify(patch.scratchpad, (_k, v) => {
            if (v instanceof Set) return Array.from(v);
            if (v instanceof Map) return Object.fromEntries(v);
            return v;
          }),
        )
      : undefined;

    // Build SET clause dynamically so callers can patch any subset.
    const sets: string[] = [];
    const params: unknown[] = [];
    if (safeScratch !== undefined) {
      sets.push(`scratchpad = $${params.length + 1}::jsonb`);
      params.push(JSON.stringify(safeScratch));
    }
    if (patch.lastFinishReason !== undefined) {
      sets.push(`last_finish_reason = $${params.length + 1}`);
      params.push(patch.lastFinishReason);
    }
    if (patch.awaitingQuestion !== undefined) {
      sets.push(`awaiting_question = $${params.length + 1}`);
      params.push(patch.awaitingQuestion);
    }
    if (patch.messageCount !== undefined) {
      sets.push(`message_count = $${params.length + 1}`);
      params.push(patch.messageCount);
    }
    if (patch.sessionInputTokens !== undefined) {
      sets.push(`session_input_tokens = $${params.length + 1}`);
      params.push(patch.sessionInputTokens);
    }
    if (patch.sessionOutputTokens !== undefined) {
      sets.push(`session_output_tokens = $${params.length + 1}`);
      params.push(patch.sessionOutputTokens);
    }
    if (patch.sessionSteps !== undefined) {
      sets.push(`session_steps = $${params.length + 1}`);
      params.push(patch.sessionSteps);
    }
    if (patch.autoResumeCount !== undefined) {
      sets.push(`auto_resume_count = $${params.length + 1}`);
      params.push(patch.autoResumeCount);
    }

    // Always read back the etag so callers can chain a follow-up save.
    if (sets.length === 0) {
      const r = await client.query<{ etag: string }>(
        `SELECT etag::text AS etag FROM agent_sessions WHERE id = $1::uuid`,
        [sessionId],
      );
      const row = r.rows[0];
      if (!row) throw new OptimisticLockError(sessionId);
      return { etag: row.etag };
    }

    params.push(sessionId);
    const idIdx = params.length;
    let sql = `UPDATE agent_sessions SET ${sets.join(", ")} WHERE id = $${idIdx}::uuid`;
    if (patch.expectedEtag !== undefined) {
      params.push(patch.expectedEtag);
      sql += ` AND etag = $${params.length}::uuid`;
    }
    sql += ` RETURNING etag::text AS etag`;

    const r = await client.query<{ etag: string }>(sql, params);
    const row = r.rows[0];
    if (!row) throw new OptimisticLockError(sessionId);
    return { etag: row.etag };
  });
}

// ---------------------------------------------------------------------------
// Todo CRUD — used by the manage_todos builtin tool.
// ---------------------------------------------------------------------------

/** Insert a batch of new todos. Ordering is auto-assigned starting from MAX+1. */
export async function createTodos(
  pool: Pool,
  userEntraId: string,
  sessionId: string,
  contents: string[],
): Promise<Todo[]> {
  if (contents.length === 0) return [];
  return await withUserContext(pool, userEntraId, async (client) => {
    const maxR = await client.query<{ max: number | null }>(
      `SELECT COALESCE(MAX(ordering), 0) AS max
         FROM agent_todos WHERE session_id = $1::uuid`,
      [sessionId],
    );
    let nextOrdering = (maxR.rows[0]?.max ?? 0) + 1;

    const rows: TodoRow[] = [];
    for (const content of contents) {
      const r = await client.query<TodoRow>(
        `INSERT INTO agent_todos (session_id, ordering, content)
         VALUES ($1::uuid, $2, $3)
         RETURNING id::text AS id, ordering, content, status, created_at, updated_at`,
        [sessionId, nextOrdering, content],
      );
      const inserted = r.rows[0];
      if (inserted) rows.push(inserted);
      nextOrdering++;
    }
    return rowsToTodos(rows);
  });
}

/** Update a single todo's status (or content). Returns the updated row. */
export async function updateTodo(
  pool: Pool,
  userEntraId: string,
  todoId: string,
  patch: { status?: TodoStatus; content?: string },
): Promise<Todo | null> {
  return await withUserContext(pool, userEntraId, async (client) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push(`status = $${params.length + 1}`);
      params.push(patch.status);
    }
    if (patch.content !== undefined) {
      sets.push(`content = $${params.length + 1}`);
      params.push(patch.content);
    }
    if (sets.length === 0) return null;
    params.push(todoId);
    const r = await client.query<TodoRow>(
      `UPDATE agent_todos SET ${sets.join(", ")}
        WHERE id = $${params.length}::uuid
        RETURNING id::text AS id, ordering, content, status, created_at, updated_at`,
      params,
    );
    const row = r.rows[0];
    return row ? rowsToTodos([row])[0] ?? null : null;
  });
}

/**
 * Atomically increment auto_resume_count IF the cap hasn't been reached AND
 * the session isn't paused on a clarifying question. Returns the new count
 * on success, or null if the increment was refused (cap reached, awaiting
 * user input, or row missing).
 *
 * Uses a single `UPDATE ... WHERE ... RETURNING` so two parallel resume
 * calls cannot both pass the cap check and double-increment. Replaces the
 * earlier read-then-write pattern that left a race window.
 */
export async function tryIncrementAutoResumeCount(
  pool: Pool,
  userEntraId: string,
  sessionId: string,
): Promise<number | null> {
  return await withUserContext(pool, userEntraId, async (client) => {
    const r = await client.query<{ auto_resume_count: number }>(
      `UPDATE agent_sessions
          SET auto_resume_count = auto_resume_count + 1
        WHERE id = $1::uuid
          AND auto_resume_count < auto_resume_cap
          AND (last_finish_reason IS NULL OR last_finish_reason <> 'awaiting_user_input')
        RETURNING auto_resume_count`,
      [sessionId],
    );
    return r.rows[0]?.auto_resume_count ?? null;
  });
}

/** List all todos for a session, ordered. */
export async function listTodos(
  pool: Pool,
  userEntraId: string,
  sessionId: string,
): Promise<Todo[]> {
  return await withUserContext(pool, userEntraId, async (client) => {
    const r = await client.query<TodoRow>(
      `SELECT id::text AS id, ordering, content, status, created_at, updated_at
         FROM agent_todos
        WHERE session_id = $1::uuid
        ORDER BY ordering ASC`,
      [sessionId],
    );
    return rowsToTodos(r.rows);
  });
}
