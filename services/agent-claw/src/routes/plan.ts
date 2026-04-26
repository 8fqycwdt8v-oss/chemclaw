// POST /api/chat/plan/approve — resume a saved plan.
// POST /api/chat/plan/reject  — drop a saved plan.
//
// Plans are saved by the /plan-mode path in the chat route.
// Phase D will persist these in Paperclip-lite; for now they live in the
// in-process planStore (5-minute TTL).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PromptRegistry } from "../prompts/registry.js";
import { Budget } from "../core/budget.js";
import { runHarness } from "../core/harness.js";
import { planStore } from "../core/plan-mode.js";
import { buildDefaultLifecycle } from "../core/harness-builders.js";
import { runWithRequestContext } from "../core/request-context.js";
import type { ToolContext } from "../core/types.js";
import type { Pool } from "pg";

export interface PlanRouteDeps {
  config: Config;
  pool: Pool;
  llm: LlmProvider;
  registry: ToolRegistry;
  promptRegistry: PromptRegistry;
  getUser: (req: FastifyRequest) => string;
}

const PlanActionSchema = z.object({ plan_id: z.string().uuid() });

// SSE helper.
function writeEvent(reply: FastifyReply, payload: unknown): void {
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

export function registerPlanRoutes(app: FastifyInstance, deps: PlanRouteDeps): void {
  // POST /api/chat/plan/approve
  app.post("/api/chat/plan/approve", async (req, reply) => {
    const parsed = PlanActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", detail: parsed.error.issues });
    }

    const plan = planStore.get(parsed.data.plan_id);
    if (!plan) {
      return reply.code(404).send({ error: "plan_not_found" });
    }

    // Remove plan from store (consumed).
    planStore.delete(parsed.data.plan_id);

    const user = deps.getUser(req);
    const tools = deps.registry.all();

    const seenFactIds = new Set<string>();
    const scratchpad = new Map<string, unknown>();
    scratchpad.set("seenFactIds", seenFactIds);
    scratchpad.set("budget", {
      promptTokensUsed: 0,
      completionTokensUsed: 0,
      tokenBudget: deps.config.AGENT_TOKEN_BUDGET,
    });

    const ctx: ToolContext = {
      userEntraId: user,
      seenFactIds,
      scratchpad,
    };

    const lifecycle = buildDefaultLifecycle();

    const budget = new Budget({
      maxSteps: deps.config.AGENT_CHAT_MAX_STEPS,
      maxPromptTokens: deps.config.AGENT_TOKEN_BUDGET,
    });

    // SSE streaming resume.
    setupSse(reply);
    let closed = false;
    req.raw.on("close", () => { closed = true; });

    try {
      writeEvent(reply, { type: "text_delta", delta: "Plan approved — executing…\n\n" });

      // Wrap in AsyncLocalStorage so outbound MCP calls inherit the user.
      const result = await runWithRequestContext({ userEntraId: user }, () =>
        runHarness({
          messages: plan.messages,
          tools,
          llm: deps.llm,
          budget,
          lifecycle,
          ctx,
        }),
      );

      if (!closed) {
        writeEvent(reply, { type: "text_delta", delta: result.text });
        writeEvent(reply, {
          type: "finish",
          finishReason: result.finishReason,
          usage: result.usage,
        });
      }
    } catch (err) {
      req.log.error({ err }, "plan/approve: harness failed");
      if (!closed) {
        writeEvent(reply, { type: "error", error: "internal" });
      }
    } finally {
      try { reply.raw.end(); } catch { /* already closed */ }
    }
  });

  // POST /api/chat/plan/reject
  app.post("/api/chat/plan/reject", async (req, reply) => {
    const parsed = PlanActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", detail: parsed.error.issues });
    }

    const existed = planStore.delete(parsed.data.plan_id);
    if (!existed) {
      return reply.code(404).send({ error: "plan_not_found" });
    }

    return reply.send({ ok: true, message: "Plan rejected and discarded." });
  });

  // GET /api/chat/plan/:plan_id — retrieve plan details (for testing).
  app.get("/api/chat/plan/:plan_id", async (req, reply) => {
    const { plan_id } = req.params as { plan_id: string };
    const plan = planStore.get(plan_id);
    if (!plan) {
      return reply.code(404).send({ error: "plan_not_found" });
    }
    return reply.send({
      plan_id: plan.plan_id,
      steps: plan.steps,
      created_at: plan.created_at,
    });
  });
}
