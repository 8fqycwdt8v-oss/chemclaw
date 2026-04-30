// Shared schemas, types, and helpers for the chat route.
//
// Extracted from routes/chat.ts as part of the PR-6 god-file split.
// Lives next to chat.ts (not in core/) because each piece is specific to
// the chat endpoint's request shape, error mapping, and feedback table —
// no other route imports them.

import { z } from "zod";
import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PromptRegistry } from "../prompts/registry.js";
import type { SkillLoader } from "../core/skills.js";
import type { PaperclipClient } from "../core/paperclip-client.js";
import type { ShadowEvaluator } from "../prompts/shadow-evaluator.js";
import { withUserContext } from "../db/with-user-context.js";

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  toolId: z.string().optional(),
});

export const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional(),
  agent_trace_id: z.string().optional(),
  // Resume an existing session: scratchpad + todos + awaiting_question
  // are loaded from the agent_sessions row and threaded into ctx. If
  // omitted, a new session is created and emitted via the `session` SSE event.
  session_id: z.string().uuid().optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ChatRouteDeps {
  config: Config;
  pool: Pool;
  llm: LlmProvider;
  registry: ToolRegistry;
  promptRegistry: PromptRegistry;
  /** Extract the user's Entra-ID (or dev email) from the request. */
  getUser: (req: FastifyRequest) => string;
  /** Skill loader — optional; if absent, skill filtering is skipped. */
  skillLoader?: SkillLoader;
  /** Paperclip-lite client. When configured, reserves/releases per-turn
   * budget against the sidecar; a 429 surfaces as HTTP 429 with Retry-After. */
  paperclip?: PaperclipClient;
  /** Shadow evaluator — fires off shadow prompts after the user response. */
  shadowEvaluator?: ShadowEvaluator;
}

// ---------------------------------------------------------------------------
// AbortError detection
// ---------------------------------------------------------------------------

/**
 * Recognise a thrown AbortError regardless of its concrete constructor.
 * Mirrors core/harness.ts._isAbortError — duplicated to keep this file's
 * import surface narrow (no import from core/harness.ts internals). The
 * AI SDK, Node fetch, and our own DOMException all share the .name
 * discriminator.
 */
export function isAbortLikeError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

// ---------------------------------------------------------------------------
// Bounds check
// ---------------------------------------------------------------------------

export function enforceBounds(
  req: ChatRequest,
  config: Config,
): { ok: true } | { ok: false; status: number; body: Record<string, unknown> } {
  if (req.messages.length > config.AGENT_CHAT_MAX_HISTORY) {
    return {
      ok: false,
      status: 413,
      body: { error: "history_too_long", max: config.AGENT_CHAT_MAX_HISTORY },
    };
  }
  for (const m of req.messages) {
    if (m.content.length > config.AGENT_CHAT_MAX_INPUT_CHARS) {
      return {
        ok: false,
        status: 413,
        body: { error: "message_too_long", max: config.AGENT_CHAT_MAX_INPUT_CHARS },
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Feedback writer (used by the /feedback slash short-circuit).
// ---------------------------------------------------------------------------

export async function recordFeedback(
  pool: Pool,
  userEntraId: string,
  signal: string,
  reason: string,
  traceId: string | undefined,
): Promise<void> {
  await withUserContext(pool, userEntraId, async (client) => {
    await client.query(
      `INSERT INTO feedback_events (user_entra_id, signal, query_text, trace_id)
       VALUES ($1, $2, $3, $4)`,
      [userEntraId, signal, reason, traceId ?? null],
    );
  });
}
