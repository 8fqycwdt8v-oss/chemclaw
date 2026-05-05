// POST /api/chat/plan/approve — resume a saved plan.
// POST /api/chat/plan/reject  — drop a saved plan.
//
// Plans are saved by the /plan-mode path in the chat route.
// Phase D will persist these in Paperclip-lite; for now they live in the
// in-process planStore (5-minute TTL).

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PromptRegistry } from "../prompts/registry.js";
import { Budget } from "../core/budget.js";
import { runHarness } from "../core/harness.js";
import { planStore } from "../core/plan-mode.js";
import { hydrateScratchpad } from "../core/session-state.js";
import { lifecycle } from "../core/runtime.js";
import { runWithRequestContext } from "../core/request-context.js";
import { hashUser } from "../observability/user-hash.js";
import { startRootTurnSpan, recordSpanError } from "../observability/spans.js";
import { context as otelContext, trace } from "@opentelemetry/api";
import { writeEvent, setupSse } from "../streaming/sse.js";
import { isAbortLikeError } from "./chat-helpers.js";
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

export function registerPlanRoutes(app: FastifyInstance, deps: PlanRouteDeps): void {
  // POST /api/chat/plan/approve
  app.post("/api/chat/plan/approve", async (req, reply) => {
    const parsed = PlanActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return await reply.code(400).send({ error: "invalid_input", detail: parsed.error.issues });
    }

    const plan = planStore.get(parsed.data.plan_id);
    if (!plan) {
      return await reply.code(404).send({ error: "plan_not_found" });
    }

    // Owner check: a leaked plan_id mustn't let user A run user B's plan.
    const user = deps.getUser(req);
    if (plan.user_entra_id !== user) {
      // 404 (not 403) so we don't leak the existence of plans across users.
      return await reply.code(404).send({ error: "plan_not_found" });
    }

    // Remove plan from store (consumed).
    planStore.delete(parsed.data.plan_id);

    const tools = deps.registry.all();

    // Resume from a freshly-approved plan: prior scratchpad is empty since
    // plan-mode itself runs without invoking tools.
    const { scratchpad, seenFactIds } = hydrateScratchpad(
      {},
      null,
      deps.config.AGENT_TOKEN_BUDGET,
    );
    // Pass `lifecycle` explicitly so tools that fire fine-grained events
    // (e.g. manage_todos → task_created / task_completed) work even before
    // the harness's own backfill at harness.ts:57-59 runs.
    const ctx: ToolContext = {
      userEntraId: user,
      seenFactIds,
      scratchpad,
      lifecycle,
    };

    const budget = new Budget({
      maxSteps: deps.config.AGENT_CHAT_MAX_STEPS,
      maxPromptTokens: deps.config.AGENT_TOKEN_BUDGET,
    });

    // SSE streaming resume.
    setupSse(reply);
    // Boxed so the value can be mutated by the close-handler closure without
    // TS narrowing every subsequent read to the literal `false` initializer.
    const conn: { closed: boolean } = { closed: false };
    req.raw.on("close", () => { conn.closed = true; });

    // Open the OTel root span for the plan-approve turn so every hook
    // and tool span emitted by `tracer.startActiveSpan` nests under it
    // (mirrors /api/chat). Without the span Langfuse shows hook/tool
    // spans as orphans and the `prompt:agent.system` tag never lands on
    // the trace, so the GEPA runner's tag-filtered fetch misses these
    // executions.
    const rootSpan = startRootTurnSpan({
      traceId: parsed.data.plan_id,
      userEntraId: user,
      model: deps.config.AGENT_MODEL,
      promptName: "agent.system",
    });
    const turnCtx = trace.setSpan(otelContext.active(), rootSpan);
    try {
      writeEvent(reply, { type: "text_delta", delta: "Plan approved — executing…\n\n" });

      // Wrap in AsyncLocalStorage so outbound MCP calls inherit the user
      // and the upstream client's AbortSignal — a mid-stream disconnect
      // here cancels both LLM calls and any in-flight MCP fetches.
      // The OTel `otelContext.with(turnCtx, …)` wrap parents hook + tool
      // spans under rootSpan; ALS context manager threads it through
      // the awaits inside runHarness.
      const result = await runWithRequestContext(
        {
          userEntraId: user,
          signal: req.signal,
          requestId: req.id,
          userHash: hashUser(user),
        },
        () =>
          otelContext.with(turnCtx, () =>
            runHarness({
              messages: plan.messages,
              tools,
              llm: deps.llm,
              budget,
              lifecycle,
              ctx,
              signal: req.signal,
              // Engage the permission resolver in enforce mode so DB-backed
              // permission_policies fire on the plan/approve path as they do
              // on /api/chat. Permissive default (allow when no policy matches).
              permissions: { permissionMode: "enforce" },
            }),
          ),
      );

      if (!conn.closed) {
        writeEvent(reply, { type: "text_delta", delta: result.text });
        writeEvent(reply, {
          type: "finish",
          finishReason: result.finishReason,
          usage: result.usage,
        });
      }
    } catch (err) {
      try { recordSpanError(rootSpan, err); } catch { /* ignore */ }
      // Distinguish a client-cancelled abort from a real failure: an
      // AbortError (mid-stream disconnect / req.signal aborted) is not
      // an "internal" error — emit the typed `cancelled` event instead
      // so the SSE consumer (and DB last_finish_reason analytics) sees
      // the cancellation as such rather than a server-side bug.
      if (isAbortLikeError(err) || req.signal.aborted) {
        req.log.info(
          { err: err instanceof Error ? err.message : err },
          "plan/approve: stream cancelled by client",
        );
        if (!conn.closed) {
          try {
            writeEvent(reply, { type: "cancelled" });
          } catch {
            // socket already gone
          }
        }
      } else {
        req.log.error({ err }, "plan/approve: harness failed");
        if (!conn.closed) {
          writeEvent(reply, { type: "error", error: "internal" });
        }
      }
    } finally {
      try { rootSpan.end(); } catch { /* OTel no-op or already ended */ }
      try { reply.raw.end(); } catch { /* already closed */ }
    }
  });

  // POST /api/chat/plan/reject
  app.post("/api/chat/plan/reject", async (req, reply) => {
    const parsed = PlanActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return await reply.code(400).send({ error: "invalid_input", detail: parsed.error.issues });
    }

    // Owner check before delete.
    const plan = planStore.get(parsed.data.plan_id);
    if (!plan) {
      return await reply.code(404).send({ error: "plan_not_found" });
    }
    const user = deps.getUser(req);
    if (plan.user_entra_id !== user) {
      return await reply.code(404).send({ error: "plan_not_found" });
    }

    planStore.delete(parsed.data.plan_id);
    return await reply.send({ ok: true, message: "Plan rejected and discarded." });
  });

  // GET /api/chat/plan/:plan_id — retrieve plan details (for testing + UI preview).
  app.get("/api/chat/plan/:plan_id", async (req, reply) => {
    const { plan_id } = req.params as { plan_id: string };
    const plan = planStore.get(plan_id);
    if (!plan) {
      return await reply.code(404).send({ error: "plan_not_found" });
    }
    // Owner check.
    const user = deps.getUser(req);
    if (plan.user_entra_id !== user) {
      return await reply.code(404).send({ error: "plan_not_found" });
    }
    return await reply.send({
      plan_id: plan.plan_id,
      steps: plan.steps,
      created_at: plan.created_at,
    });
  });
}
