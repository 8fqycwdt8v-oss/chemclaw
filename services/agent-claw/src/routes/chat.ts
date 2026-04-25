// POST /api/chat — SSE-streaming chat endpoint.
//
// Request shape (matches legacy services/agent/src/routes/chat.ts):
//   {
//     "messages": [{"role":"user","content":"..."}],
//     "stream": true|false,
//     "agent_trace_id": "<optional — last assistant turn's trace key for /feedback>"
//   }
//
// Pre-pass: the slash router is checked first. isStreamable=false verbs emit
// a single text-completion + finish event without invoking the harness.
//
// SSE event types: text_delta | tool_call | tool_result | finish | error
//
// Defences:
//   - Dedicated lower rate limit (AGENT_CHAT_RATE_LIMIT_MAX).
//   - History cap (AGENT_CHAT_MAX_HISTORY) + per-message cap (AGENT_CHAT_MAX_INPUT_CHARS).
//   - Server-enforced maxSteps on the agent loop.
//   - Terminal-event guarantee: finish or error always emitted.
//   - Plan mode: pre_tool hook intercepts tool calls with no-op previews.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import { Lifecycle } from "../core/lifecycle.js";
import { Budget } from "../core/budget.js";
import { buildAgent } from "../core/harness.js";
import {
  parseSlash,
  parseFeedbackArgs,
  shortCircuitResponse,
  HELP_TEXT,
} from "../core/slash.js";
import { registerRedactSecretsHook } from "../core/hooks/redact-secrets.js";
import { registerTagMaturityHook } from "../core/hooks/tag-maturity.js";
import { registerBudgetGuardHook } from "../core/hooks/budget-guard.js";
import { withUserContext } from "../db/with-user-context.js";
import { PromptRegistry } from "../prompts/registry.js";
import type { Message, ToolContext } from "../core/types.js";
import type { PreToolPayload } from "../core/types.js";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; toolId: string; input: unknown }
  | { type: "tool_result"; toolId: string; output: unknown }
  | { type: "finish"; finishReason: string; usage: { promptTokens: number; completionTokens: number } }
  | { type: "error"; error: string };

const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  toolId: z.string().optional(),
});

const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional(),
  agent_trace_id: z.string().optional(),
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
// SSE helpers
// ---------------------------------------------------------------------------

function writeEvent(reply: FastifyReply, payload: StreamEvent): void {
  const json = JSON.stringify(payload).replace(/\r?\n/g, "\\n");
  reply.raw.write(`data: ${json}\n\n`);
}

function setupSse(reply: FastifyReply): void {
  reply.raw.statusCode = 200;
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.hijack();
}

// ---------------------------------------------------------------------------
// Plan-mode hook: intercepts tool calls and returns a no-op preview.
// Registered programmatically (not from YAML) per turn when verb === "plan".
// ---------------------------------------------------------------------------

function buildPlanModeLifecycle(): Lifecycle {
  const lc = new Lifecycle();
  registerRedactSecretsHook(lc);
  registerTagMaturityHook(lc);
  registerBudgetGuardHook(lc);

  // Plan-mode pre_tool: abort actual execution with a preview message.
  lc.on("pre_tool", "plan-mode-intercept", async (payload: PreToolPayload) => {
    const inputSummary = JSON.stringify(payload.input).slice(0, 200);
    throw Object.assign(
      new Error(`(plan mode — would call ${payload.toolId} with ${inputSummary})`),
      { isPlanMode: true },
    );
  });

  return lc;
}

function buildDefaultLifecycle(): Lifecycle {
  const lc = new Lifecycle();
  registerRedactSecretsHook(lc);
  registerTagMaturityHook(lc);
  registerBudgetGuardHook(lc);
  return lc;
}

// ---------------------------------------------------------------------------
// Feedback writer
// ---------------------------------------------------------------------------

async function writeFeedback(
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
      [userEntraId, signal, reason || null, traceId || null],
    );
  });
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

  // ------- Slash pre-pass -------
  const lastUserMessage = [...body.messages].reverse().find((m) => m.role === "user");
  const slashResult = lastUserMessage
    ? parseSlash(lastUserMessage.content)
    : { verb: "", args: "", remainingText: "", isStreamable: true };

  // Short-circuit verbs that don't need the LLM.
  if (!slashResult.isStreamable && slashResult.verb !== "") {
    const verb = slashResult.verb;

    // Unknown verb.
    if (!["help", "skills", "feedback", "check", "learn"].includes(verb)) {
      const errText = `Unknown command /${verb}. Try /help.`;
      if (!doStream) {
        return void reply.send({ text: errText });
      }
      setupSse(reply);
      writeEvent(reply, { type: "text_delta", delta: errText });
      writeEvent(reply, {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0 },
      });
      reply.raw.end();
      return;
    }

    // /feedback — needs DB write.
    if (verb === "feedback") {
      const fbArgs = parseFeedbackArgs(slashResult.args);
      if (!fbArgs) {
        const errText = `Invalid /feedback syntax. Usage: /feedback up|down "reason"`;
        if (!doStream) return void reply.send({ text: errText });
        setupSse(reply);
        writeEvent(reply, { type: "text_delta", delta: errText });
        writeEvent(reply, {
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 0, completionTokens: 0 },
        });
        reply.raw.end();
        return;
      }
      try {
        await writeFeedback(
          deps.pool,
          user,
          fbArgs.signal,
          fbArgs.reason,
          body.agent_trace_id,
        );
        const text = `Thanks for your feedback (${fbArgs.signal}).`;
        if (!doStream) return void reply.send({ text });
        setupSse(reply);
        writeEvent(reply, { type: "text_delta", delta: text });
        writeEvent(reply, {
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 0, completionTokens: 0 },
        });
        reply.raw.end();
        return;
      } catch (err) {
        req.log.error({ err }, "feedback write failed");
        if (!doStream) return void reply.code(500).send({ error: "internal" });
        setupSse(reply);
        writeEvent(reply, { type: "error", error: "feedback_write_failed" });
        reply.raw.end();
        return;
      }
    }

    // Other short-circuit verbs (/help, /skills, /check, /learn).
    const text = shortCircuitResponse(verb) ?? HELP_TEXT;
    if (!doStream) return void reply.send({ text });
    setupSse(reply);
    writeEvent(reply, { type: "text_delta", delta: text });
    writeEvent(reply, {
      type: "finish",
      finishReason: "stop",
      usage: { promptTokens: 0, completionTokens: 0 },
    });
    reply.raw.end();
    return;
  }

  // ------- Harness path -------
  const isPlanMode = slashResult.verb === "plan";

  // Build system prompt: AGENTS.md preamble + active prompt_registry row.
  let systemPrompt = "";
  try {
    // Load AGENTS.md preamble from the prompt registry.
    // If not seeded yet, fall back gracefully (don't crash).
    try {
      const { template } = await deps.promptRegistry.getActive("agent.system");
      systemPrompt = template;
    } catch {
      req.log.warn("agent.system prompt not found in prompt_registry; using minimal fallback");
      systemPrompt = "You are ChemClaw, an autonomous chemistry knowledge agent.";
    }
  } catch (err) {
    req.log.error({ err }, "failed to load system prompt");
    systemPrompt = "You are ChemClaw, an autonomous chemistry knowledge agent.";
  }

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    ...body.messages.map((m) => ({
      role: m.role as Message["role"],
      content:
        isPlanMode && m.role === "user" && m === lastUserMessage
          ? `[PLAN MODE] ${slashResult.remainingText || m.content}`
          : m.content,
      toolId: m.toolId,
    })),
  ];

  // seenFactIds starts empty — init-scratch pre_turn hook and the harness
  // will wire it through the scratchpad before the first tool call.
  const _initialSeenFactIds = new Set<string>();
  const _scratchpad = new Map<string, unknown>();
  _scratchpad.set("budget", {
    promptTokensUsed: 0,
    completionTokensUsed: 0,
    tokenBudget: deps.config.AGENT_TOKEN_BUDGET,
  });
  _scratchpad.set("seenFactIds", _initialSeenFactIds);
  const ctx: ToolContext = {
    userEntraId: user,
    seenFactIds: _initialSeenFactIds,
    scratchpad: _scratchpad,
  };

  const lifecycle = isPlanMode ? buildPlanModeLifecycle() : buildDefaultLifecycle();
  const tools = deps.registry.all();

  const agent = buildAgent({
    llm: deps.llm,
    tools,
    lifecycle,
    maxSteps: deps.config.AGENT_CHAT_MAX_STEPS,
    maxPromptTokens: deps.config.AGENT_TOKEN_BUDGET,
  });

  if (!doStream) {
    // Non-streaming path.
    try {
      const result = await agent.run({ messages, ctx });
      let text = result.text;
      if (isPlanMode) text = `**PLAN PREVIEW**\n\n${text}`;
      return void reply.send({ text, finishReason: result.finishReason, usage: result.usage });
    } catch (err) {
      req.log.error({ err }, "chat generate failed");
      return void reply.code(500).send({ error: "internal" });
    }
  }

  // ------- SSE streaming path -------
  setupSse(reply);

  let closed = false;
  const onClose = () => { closed = true; };
  req.raw.on("close", onClose);
  req.raw.on("aborted", onClose);

  try {
    // Collect plan-mode intercept messages as text_delta events.
    if (isPlanMode) {
      writeEvent(reply, {
        type: "text_delta",
        delta: "**PLAN PREVIEW**\n\nAnalyzing your request...\n\n",
      });
    }

    // Token-by-token streaming path.
    // We run the harness loop manually, using streamCompletion() for the final
    // text step so tokens flow to the client as they arrive. Tool-call steps
    // still use call() (blocking) because we need the result before continuing.
    //
    // Strategy:
    //   1. Build a Budget + Lifecycle as normal.
    //   2. Fire pre_turn.
    //   3. Loop: call the LLM with call(). If it returns tool_call, emit
    //      tool_call + tool_result events, push to messages, continue.
    //   4. When the model produces a text response, switch to streamCompletion()
    //      to emit token-by-token text_delta events.
    //   5. Emit finish.
    //
    // This gives real streaming for the text portion while keeping the harness
    // semantics (hooks, budget, tool execution) intact.

    await lifecycle.dispatch("pre_turn", { ctx, messages });

    const budget = new Budget({
      maxSteps: deps.config.AGENT_CHAT_MAX_STEPS,
      maxPromptTokens: deps.config.AGENT_TOKEN_BUDGET,
    });

    let finishReason = "stop";
    let finalText = "";
    let stepsUsed = 0;

    streaming: while (true) {
      if (closed) break;
      if (budget.isStepCapReached()) {
        finishReason = "max_steps";
        break;
      }

      // Peek at what the LLM wants to do next.
      const { result: stepResult, usage } = await deps.llm.call(messages, tools);
      budget.consumeStep(usage);
      stepsUsed++;

      if (stepResult.kind === "tool_call") {
        // Tool-call step — execute the tool, emit events, push to messages.
        const { toolId, input } = stepResult;

        // pre_tool hook.
        const prePayload: PreToolPayload = { ctx, toolId, input };
        await lifecycle.dispatch("pre_tool", prePayload);
        const effectiveInput = prePayload.input;

        const tool = tools.find((t) => t.id === toolId);
        if (!tool) {
          writeEvent(reply, { type: "error", error: `unknown_tool:${toolId}` });
          break streaming;
        }

        const parsedInput = tool.inputSchema.parse(effectiveInput);
        writeEvent(reply, { type: "tool_call", toolId, input: parsedInput });

        const rawOutput = await tool.execute(ctx, parsedInput);
        const parsedOutput = tool.outputSchema.parse(rawOutput);

        const postPayload = { ctx, toolId, input: effectiveInput, output: parsedOutput };
        await lifecycle.dispatch("post_tool", postPayload);
        const effectiveOutput = postPayload.output;

        writeEvent(reply, { type: "tool_result", toolId, output: effectiveOutput });

        const toolResultContent = effectiveOutput !== undefined
          ? JSON.stringify(effectiveOutput)
          : `{"error":"no_output"}`;

        messages.push({ role: "tool", content: toolResultContent, toolId });
        continue;
      }

      // Text step — stream token-by-token using streamCompletion().
      // We already used call() to determine this is a text step; we now switch
      // to streamCompletion() so tokens flow to the client as they arrive.
      // Fall back to a single text_delta if streaming throws.
      finalText = stepResult.text;
      if (isPlanMode) finalText = `**PLAN PREVIEW**\n\n${finalText}`;

      if (!closed) {
        try {
          let streamed = "";
          for await (const chunk of deps.llm.streamCompletion(messages, tools)) {
            if (closed) break;
            if (chunk.type === "text_delta") {
              streamed += chunk.delta;
              writeEvent(reply, { type: "text_delta", delta: chunk.delta });
            }
            // finish/tool_call chunks from the stream are not re-emitted here;
            // the harness emits its own finish event below.
          }
          // If the stream yielded text, use it as the canonical final text.
          if (streamed) {
            finalText = isPlanMode ? `**PLAN PREVIEW**\n\n${streamed}` : streamed;
          }
        } catch {
          // Stream failed — fall back to the complete text we got from call().
          writeEvent(reply, { type: "text_delta", delta: finalText });
        }
      }

      messages.push({ role: "assistant", content: finalText });
      break streaming;
    }

    await lifecycle.dispatch("post_turn", { ctx, finalText, stepsUsed });

    if (!closed) {
      writeEvent(reply, {
        type: "finish",
        finishReason,
        usage: budget.summary(),
      });
    }
  } catch (err) {
    req.log.error({ err }, "chat stream failed");
    // Terminal-event guarantee: always emit error before closing.
    if (!closed) {
      writeEvent(reply, { type: "error", error: "internal" });
    }
  } finally {
    try {
      reply.raw.end();
    } catch {
      // already closed
    }
  }
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
    (req, reply) => handleChat(req, reply, deps),
  );
}
