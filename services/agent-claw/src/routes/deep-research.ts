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
import {
  parseSlash,
  parseFeedbackArgs,
  shortCircuitResponse,
  HELP_TEXT,
} from "../core/slash.js";
import { withUserContext } from "../db/with-user-context.js";
import { PromptRegistry } from "../prompts/registry.js";
import { runWithRequestContext } from "../core/request-context.js";
import { AwaitingUserInputError } from "../tools/builtins/ask_user.js";
import { hydrateScratchpad } from "../core/session-state.js";
import { lifecycle } from "../core/runtime.js";
import type { Message, ToolContext } from "../core/types.js";
import type { PreToolPayload } from "../core/types.js";
import { writeEvent, setupSse } from "../streaming/sse.js";

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
      role: m.role as Message["role"],
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
    // Non-streaming path.
    try {
      await lifecycle.dispatch("pre_turn", { ctx, messages });
      const budget = new Budget({
        maxSteps: drMaxSteps,
        maxPromptTokens: deps.config.AGENT_TOKEN_BUDGET,
      });
      const { result, usage } = await deps.llm.call(messages, tools);
      budget.consumeStep(usage);
      const text = result.kind === "text" ? result.text : `(tool: ${result.toolId})`;
      await lifecycle.dispatch("post_turn", { ctx, finalText: text, stepsUsed: 1 });
      return void reply.send({ text, finishReason: "stop", usage: budget.summary() });
    } catch (err) {
      req.log.error({ err }, "deep_research generate failed");
      return void reply.code(500).send({ error: "internal" });
    }
  }

  // Streaming path.
  setupSse(reply);

  let closed = false;
  const onClose = () => { closed = true; };
  req.raw.on("close", onClose);
  req.raw.on("aborted", onClose);

  try {
    await lifecycle.dispatch("pre_turn", { ctx, messages });

    const budget = new Budget({
      maxSteps: drMaxSteps,
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

      const { result: stepResult, usage } = await deps.llm.call(messages, tools);
      budget.consumeStep(usage);
      stepsUsed++;

      if (stepResult.kind === "tool_call") {
        const { toolId, input } = stepResult;
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

        // AwaitingUserInputError is a control-flow exception (ask_user); catch
        // it here so post_turn / SSE termination still run cleanly. Mirrors
        // routes/chat.ts. Without this, a DR session that fires ask_user
        // ends up with last_finish_reason='error' and the reanimator
        // misclassifies it as resumable.
        let rawOutput: unknown;
        try {
          rawOutput = await tool.execute(ctx, parsedInput);
        } catch (toolErr) {
          if (toolErr instanceof AwaitingUserInputError) {
            finishReason = "awaiting_user_input";
            break streaming;
          }
          throw toolErr;
        }
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

      // Text step — stream token-by-token.
      finalText = stepResult.text;
      if (!closed) {
        try {
          let streamed = "";
          for await (const chunk of deps.llm.streamCompletion(messages, tools)) {
            if (closed) break;
            if (chunk.type === "text_delta") {
              streamed += chunk.delta;
              writeEvent(reply, { type: "text_delta", delta: chunk.delta });
            }
          }
          if (streamed) finalText = streamed;
        } catch {
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
    req.log.error({ err }, "deep_research stream failed");
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
    // identity (mirrors /api/chat). Without this, the JWT minted for
    // outbound calls would have no user, and MCP services in production
    // would 401 every DR call.
    (req, reply) =>
      runWithRequestContext({ userEntraId: deps.getUser(req) }, () =>
        handleDeepResearch(req, reply, deps),
      ),
  );
}
