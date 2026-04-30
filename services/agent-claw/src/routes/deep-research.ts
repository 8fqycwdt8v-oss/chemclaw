// POST /api/deep_research — Deep Research mode alias.
//
// Phase A.4: thin shim that injects the "deep_research" skill marker into the
// chat request before forwarding to the standard chat handler.
//
// Wire format: identical to /api/chat (same SSE event types).
//
// Behaviour:
//   - Rate-limited at 1/4 the chat rate (heavier workload).
//   - Injects a one-line system-prompt suffix: "DR mode: think step by step;
//     produce a structured report." This suffix is applied by wrapping the
//     system message after prompt_registry loading.
//   - maxSteps is multiplied by 4 (capped at 40) to match Phase 4 legacy.
//
// Phase B: when skills land, this route becomes an alias for
//   POST /api/chat?skills=deep_research
// and is deleted. The shim exists so any client can reach the
// deep-research path today without changing query parameters.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import { Budget } from "../core/budget.js";
import { PromptRegistry } from "../prompts/registry.js";
import { runWithRequestContext } from "../core/request-context.js";
import { AwaitingUserInputError } from "../tools/builtins/ask_user.js";
import { hydrateScratchpad } from "../core/session-state.js";
import { lifecycle } from "../core/runtime.js";
import { runHarness } from "../core/harness.js";
import type { Message, ToolContext } from "../core/types.js";
import { writeEvent, setupSse } from "../streaming/sse.js";
import { makeSseSink } from "../streaming/sse-sink.js";
import type { RedactReplacement } from "../core/hooks/redact-secrets.js";

// ---------------------------------------------------------------------------
// Deep Research request schema (same shape as /api/chat).
// ---------------------------------------------------------------------------

const DrMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  toolId: z.string().optional(),
});

const DrRequestSchema = z.object({
  messages: z.array(DrMessageSchema).min(1),
  stream: z.boolean().optional(),
  agent_trace_id: z.string().optional(),
});

type DrRequest = z.infer<typeof DrRequestSchema>;

// ---------------------------------------------------------------------------
// Dependencies (same as ChatRouteDeps).
// ---------------------------------------------------------------------------

export interface DeepResearchRouteDeps {
  config: Config;
  pool: Pool;
  llm: LlmProvider;
  registry: ToolRegistry;
  promptRegistry: PromptRegistry;
  getUser: (req: FastifyRequest) => string;
}

// ---------------------------------------------------------------------------
// DR system prompt suffix.
// ---------------------------------------------------------------------------

const DR_SUFFIX =
  "\n\nDR mode: think step by step; produce a structured report.";

// ---------------------------------------------------------------------------
// Bounds check.
// ---------------------------------------------------------------------------

function enforceBounds(
  req: DrRequest,
  config: Config,
): { ok: true } | { ok: false; status: number; body: Record<string, unknown> } {
  if (req.messages.length > config.AGENT_CHAT_MAX_HISTORY) {
    return { ok: false, status: 413, body: { error: "history_too_long", max: config.AGENT_CHAT_MAX_HISTORY } };
  }
  for (const m of req.messages) {
    if (m.content.length > config.AGENT_CHAT_MAX_INPUT_CHARS) {
      return { ok: false, status: 413, body: { error: "message_too_long", max: config.AGENT_CHAT_MAX_INPUT_CHARS } };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Main handler.
// ---------------------------------------------------------------------------

async function handleDeepResearch(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: DeepResearchRouteDeps,
): Promise<void> {
  const user = deps.getUser(req);
  const parsed = DrRequestSchema.safeParse(req.body);

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

  // Load system prompt + apply DR suffix.
  let systemPrompt = "You are ChemClaw, an autonomous chemistry knowledge agent.";
  try {
    const { template } = await deps.promptRegistry.getActive("agent.system");
    systemPrompt = template;
  } catch {
    req.log.warn("agent.system prompt not found; using minimal DR fallback");
  }
  systemPrompt += DR_SUFFIX;

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    ...body.messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolId: m.toolId,
    })),
  ];

  // DR is single-turn (no session), so prior scratchpad is empty.
  const { scratchpad, seenFactIds } = hydrateScratchpad(
    {},
    null,
    deps.config.AGENT_TOKEN_BUDGET,
  );
  const ctx: ToolContext = {
    userEntraId: user,
    seenFactIds,
    scratchpad,
  };

  // DR mode: 4× maxSteps, capped at 40.
  const drMaxSteps = Math.min(deps.config.AGENT_CHAT_MAX_STEPS * 4, 40);
  const tools = deps.registry.all();

  req.log.info({ skill: "deep_research", maxSteps: drMaxSteps }, "DR mode active");

  if (!doStream) {
    // Non-streaming path — delegated to runHarness (no streamSink).
    // Phase 2B: previously this was a hand-rolled single-step loop with
    // manual pre_turn / post_turn dispatches. runHarness owns all of that.
    try {
      const budget = new Budget({
        maxSteps: drMaxSteps,
        maxPromptTokens: deps.config.AGENT_TOKEN_BUDGET,
      });
      const result = await runHarness({
        messages,
        tools,
        llm: deps.llm,
        budget,
        lifecycle,
        ctx,
        signal: req.signal,
      });
      return void reply.send({
        text: result.text,
        finishReason: result.finishReason,
        usage: result.usage,
      });
    } catch (err) {
      req.log.error({ err }, "deep_research generate failed");
      return void reply.code(500).send({ error: "internal" });
    }
  }

  // Streaming path — delegated to runHarness with an SSE sink.
  setupSse(reply);

  // Boxed so the value can be mutated by the close-handler closure without
  // TS narrowing every subsequent read to the literal `false` initializer.
  const conn: { closed: boolean } = { closed: false };
  const onClose = () => { conn.closed = true; };
  req.raw.on("close", onClose);
  req.raw.on("aborted", onClose);

  // Stream redaction log: each text_delta passes through redactString in the
  // sink. The DR route is single-turn (no session) so this only feeds the
  // post_turn `redact-secrets` hook's audit trail via scratchpad — there's
  // no saveSession step.
  //
  // AbortSignal propagation: see runHarness({ signal }). DR forwards the
  // upstream client's signal so a mid-stream disconnect cancels LLM calls
  // and any in-flight MCP postJson / getJson fetches transparently. The
  // route is single-turn so there's no scratchpad to persist — the
  // cancellation surfaces only as the SSE `cancelled` event (best-effort)
  // and a log entry.
  const _streamRedactions: RedactReplacement[] = [];

  try {
    const sink = makeSseSink(reply, _streamRedactions);

    const budget = new Budget({
      maxSteps: drMaxSteps,
      maxPromptTokens: deps.config.AGENT_TOKEN_BUDGET,
    });

    await runHarness({
      messages,
      tools,
      llm: deps.llm,
      budget,
      lifecycle,
      ctx,
      streamSink: sink,
      signal: req.signal,
    });
  } catch (err) {
    if (err instanceof AwaitingUserInputError) {
      // ask_user fired; runHarness already notified the sink, so the
      // awaiting_user_input event has been written to the wire. Treat
      // as a normal exit.
    } else if (_isAbortLikeError(err) || req.signal.aborted) {
      // Client disconnected mid-stream. Emit `cancelled` (best-effort) so
      // any SSE consumer that's still listening sees the typed terminal
      // frame instead of an abrupt socket close.
      req.log.info({ err: err instanceof Error ? err.message : err }, "deep_research stream cancelled by client");
      if (!conn.closed) {
        try {
          writeEvent(reply, { type: "cancelled" });
        } catch {
          // socket already gone
        }
      }
    } else {
      req.log.error({ err }, "deep_research stream failed");
      if (!conn.closed) {
        writeEvent(reply, { type: "error", error: "internal" });
      }
    }
  } finally {
    // runHarness owns the post_turn dispatch (in its own finally), so this
    // route does not redispatch — that would double-fire redact-secrets.
    // The post-merge-fix concern (post_turn must fire even on error) is
    // now satisfied by runHarness itself.
    try {
      reply.raw.end();
    } catch {
      // already closed
    }
  }
}

/**
 * Recognise a thrown AbortError regardless of its concrete constructor.
 * Mirrors the helper in routes/chat.ts — kept local so both routes stay
 * import-isolated.
 */
function _isAbortLikeError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

// ---------------------------------------------------------------------------
// Route registration.
// ---------------------------------------------------------------------------

export function registerDeepResearchRoute(
  app: FastifyInstance,
  deps: DeepResearchRouteDeps,
): void {
  // DR rate limit: 1/4 of chat rate limit.
  const drRateMax = Math.max(1, Math.floor(deps.config.AGENT_CHAT_RATE_LIMIT_MAX / 4));

  app.post(
    "/api/deep_research",
    {
      config: {
        rateLimit: {
          max: drRateMax,
          timeWindow: deps.config.AGENT_CHAT_RATE_LIMIT_WINDOW_MS,
        },
      },
    },
    // Wrap in AsyncLocalStorage so outbound MCP calls inherit the user's
    // identity (mirrors /api/chat) and the upstream AbortSignal so a
    // mid-stream disconnect cancels in-flight postJson / getJson calls.
    (req, reply) =>
      runWithRequestContext(
        { userEntraId: deps.getUser(req), signal: req.signal, requestId: req.id },
        () => handleDeepResearch(req, reply, deps),
      ),
  );
}
