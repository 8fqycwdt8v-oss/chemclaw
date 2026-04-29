// POST /api/chat — SSE-streaming chat endpoint.
//
// Request shape:
//   {
//     "messages": [{"role":"user","content":"..."}],
//     "stream": true|false,
//     "agent_trace_id": "<optional — last assistant turn's trace key for /feedback>",
//     "session_id": "<optional — UUID; resumes a session, threads scratchpad/todos/awaiting-question>"
//   }
//
// Pre-pass: the slash router is checked first. isStreamable=false verbs emit
// a single text-completion + finish event without invoking the harness.
//
// SSE event union: see ../../streaming/sse.ts (StreamEvent). Every turn ends
// with exactly one terminal event (`finish` or `error`).
//
// Defences:
//   - Dedicated lower rate limit (AGENT_CHAT_RATE_LIMIT_MAX).
//   - History cap (AGENT_CHAT_MAX_HISTORY) + per-message cap (AGENT_CHAT_MAX_INPUT_CHARS).
//   - Server-enforced maxSteps on the agent loop.
//   - Cross-turn session token budget (AGENT_TOKEN_BUDGET); breach → `error: session_budget_exceeded`.
//   - Terminal-event guarantee: finish or error always emitted.
//   - Plan mode: LLM asked to produce JSON plan; plan_step + plan_ready events emitted; no tools execute.
//
// File layout:
//   - index.ts              — handler wiring (this file)
//   - sse-stream.ts         — SSE emit helpers (sendStaticTextCompletion, sendSseError)
//   - slash-shortcircuit.ts — pre-harness slash verbs (/help, /skills, /feedback, ...)
//   - session-resolution.ts — session load-or-create + system-prompt assembly
//   - turn-orchestration.ts — non-streaming + streaming run paths
//   - end-of-turn.ts        — streaming finally block (persist, finish, release)

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import type { Config } from "../../config.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { parseSlash } from "../../core/slash.js";
import { runWithRequestContext } from "../../core/request-context.js";
import { PromptRegistry } from "../../prompts/registry.js";
import type { Message } from "../../core/types.js";
import type { SkillLoader } from "../../core/skills.js";
import type { PaperclipClient } from "../../core/paperclip-client.js";
import type { ShadowEvaluator } from "../../prompts/shadow-evaluator.js";
import { tryHandleShortCircuitSlash } from "./slash-shortcircuit.js";
import { resolveTurnState } from "./session-resolution.js";
import { runNonStreamingTurn, runStreamingTurn } from "./turn-orchestration.js";

// Re-exported so existing imports `import type { StreamEvent } from "./chat.js"`
// keep compiling — the canonical home is now ../../streaming/sse.ts.
export type { StreamEvent } from "../../streaming/sse.js";

const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  toolId: z.string().optional(),
});

const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional(),
  agent_trace_id: z.string().optional(),
  // Resume an existing session: scratchpad + todos + awaiting_question
  // are loaded from the agent_sessions row and threaded into ctx. If
  // omitted, a new session is created and emitted via the `session` SSE event.
  session_id: z.string().uuid().optional(),
});

type ChatRequest = z.infer<typeof ChatRequestSchema>;

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
// Bounds check
// ---------------------------------------------------------------------------

function enforceBounds(
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
// Main handler
// ---------------------------------------------------------------------------

async function handleChat(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ChatRouteDeps,
): Promise<void> {
  const user = deps.getUser(req);
  const parsed = ChatRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    return void reply.code(400).send({
      error: "invalid_input",
      detail: parsed.error.issues.map((i) => ({ path: i.path, msg: i.message })),
    });
  }

  const body = parsed.data;
  const bounds = enforceBounds(body, deps.config);
  if (!bounds.ok) {
    return void reply.code(bounds.status).send(bounds.body);
  }

  const doStream = body.stream ?? true;

  // ── Slash pre-pass ──────────────────────────────────────────────────────
  const lastUserMessage = [...body.messages].reverse().find((m) => m.role === "user");
  const slashResult = lastUserMessage
    ? parseSlash(lastUserMessage.content)
    : { verb: "", args: "", remainingText: "", isStreamable: true };

  // Short-circuit verbs that don't need the LLM.
  const handled = await tryHandleShortCircuitSlash(
    req,
    reply,
    slashResult,
    doStream,
    user,
    body.agent_trace_id,
    { pool: deps.pool },
  );
  if (handled) return;

  // ── Harness path ────────────────────────────────────────────────────────
  // Coerce the route deps' message shape onto the resolver's signature.
  const messagesForResolver: Message[] = body.messages.map((m) => ({
    role: m.role as Message["role"],
    content: m.content,
    toolId: m.toolId,
  }));

  const turnState = await resolveTurnState(
    req,
    { messages: messagesForResolver, session_id: body.session_id },
    user,
    slashResult,
    {
      config: deps.config,
      pool: deps.pool,
      promptRegistry: deps.promptRegistry,
      skillLoader: deps.skillLoader,
    },
  );

  const inputs = {
    user,
    sessionId: turnState.sessionId,
    sessionEtag: turnState.sessionEtag,
    sessionInputUsed: turnState.sessionInputUsed,
    sessionOutputUsed: turnState.sessionOutputUsed,
    sessionStepsUsed: turnState.sessionStepsUsed,
    sessionInputCap: turnState.sessionInputCap,
    sessionOutputCap: turnState.sessionOutputCap,
    systemPrompt: turnState.systemPrompt,
    activePromptVersion: turnState.activePromptVersion,
    cleanupSkillForTurn: turnState.cleanupSkillForTurn,
    isPlanMode: turnState.isPlanMode,
    ctx: turnState.ctx,
    messages: turnState.messages,
    lastUserContent: turnState.lastUserContent,
    agentTraceId: body.agent_trace_id,
  };

  const orchestrationDeps = {
    config: deps.config,
    pool: deps.pool,
    llm: deps.llm,
    registry: deps.registry,
    skillLoader: deps.skillLoader,
    paperclip: deps.paperclip,
    shadowEvaluator: deps.shadowEvaluator,
  };

  if (!doStream) {
    return runNonStreamingTurn(req, reply, inputs, orchestrationDeps);
  }
  return runStreamingTurn(req, reply, inputs, orchestrationDeps);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerChatRoute(app: FastifyInstance, deps: ChatRouteDeps): void {
  app.post(
    "/api/chat",
    {
      config: {
        rateLimit: {
          max: deps.config.AGENT_CHAT_RATE_LIMIT_MAX,
          timeWindow: deps.config.AGENT_CHAT_RATE_LIMIT_WINDOW_MS,
        },
      },
    },
    // Wrap the entire handler in an AsyncLocalStorage context so every
    // outbound MCP call can read the calling user's identity transparently
    // (see core/request-context.ts and mcp/postJson.ts:authHeaders).
    (req, reply) =>
      runWithRequestContext({ userEntraId: deps.getUser(req) }, () =>
        handleChat(req, reply, deps),
      ),
  );
}
