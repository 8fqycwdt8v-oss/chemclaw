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
// and is deleted. The shim exists so the Streamlit client can reach the
// deep-research path today without a frontend change.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import { Lifecycle } from "../core/lifecycle.js";
import { Budget } from "../core/budget.js";
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
import type { StreamEvent } from "./chat.js";

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
// SSE helpers (mirrors chat.ts — kept local to avoid coupling).
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
// DR lifecycle (same hooks as default chat).
// ---------------------------------------------------------------------------

function buildDrLifecycle(): Lifecycle {
  const lc = new Lifecycle();
  registerRedactSecretsHook(lc);
  registerTagMaturityHook(lc);
  registerBudgetGuardHook(lc);
  return lc;
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

  const ctx: ToolContext = {
    userEntraId: user,
    scratchpad: new Map([
      [
        "budget",
        {
          promptTokensUsed: 0,
          completionTokensUsed: 0,
          tokenBudget: deps.config.AGENT_TOKEN_BUDGET,
        },
      ],
    ]),
  };

  // DR mode: 4× maxSteps, capped at 40.
  const drMaxSteps = Math.min(deps.config.AGENT_CHAT_MAX_STEPS * 4, 40);
  const lifecycle = buildDrLifecycle();
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
    (req, reply) => handleDeepResearch(req, reply, deps),
  );
}
