// GET  /api/sessions/:id            — session status endpoint
// GET  /api/sessions                — list calling user's recent sessions
// POST /api/sessions/:id/plan/run   — Phase E: chained-execution of an active plan
// POST /api/sessions/:id/resume     — Phase I: synthetic-continue for the auto-resume cron
//
// Used by client UIs to render progress (todos), resume affordances
// (awaiting_question), and a session picker. The plan/run + resume
// endpoints are the multi-hour-autonomy unlock — both run a harness turn
// without requiring a fresh user message.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PromptRegistry } from "../prompts/registry.js";
import {
  loadSession,
  saveSession,
  OptimisticLockError,
  type SessionFinishReason,
} from "../core/session-store.js";
import {
  loadActivePlanForSession,
  advancePlan,
} from "../core/plan-store-db.js";
import { withUserContext } from "../db/with-user-context.js";
import { Lifecycle } from "../core/lifecycle.js";
import {
  Budget,
  BudgetExceededError,
  SessionBudgetExceededError,
} from "../core/budget.js";
import { runHarness } from "../core/harness.js";
import { AwaitingUserInputError } from "../tools/builtins/ask_user.js";
import { registerRedactSecretsHook } from "../core/hooks/redact-secrets.js";
import { registerTagMaturityHook } from "../core/hooks/tag-maturity.js";
import { registerBudgetGuardHook } from "../core/hooks/budget-guard.js";
import type { Message, ToolContext } from "../core/types.js";

interface SessionsRouteDeps {
  pool: Pool;
  getUser: (req: FastifyRequest) => string;
  // The chained-run + resume endpoints need the harness deps.
  config?: Config;
  llm?: LlmProvider;
  registry?: ToolRegistry;
  promptRegistry?: PromptRegistry;
}

export function registerSessionsRoute(
  app: FastifyInstance,
  deps: SessionsRouteDeps,
): void {
  const { pool, getUser } = deps;
  // -----------------------------------------------------------------------
  // GET /api/sessions/:id
  // -----------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
    const user = getUser(req);
    const sessionId = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
      return reply.code(400).send({ error: "invalid_input", detail: "session id must be a UUID" });
    }
    const state = await loadSession(pool, user, sessionId);
    if (!state) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.code(200).send({
      session_id: state.id,
      todos: state.todos.map((t) => ({
        id: t.id,
        ordering: t.ordering,
        content: t.content,
        status: t.status,
      })),
      awaiting_question: state.awaitingQuestion,
      last_finish_reason: state.lastFinishReason,
      message_count: state.messageCount,
      created_at: state.createdAt.toISOString(),
      updated_at: state.updatedAt.toISOString(),
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/sessions — list the user's recent sessions.
  // Paged via ?limit (default 20, max 100). Returns id + summary fields only.
  // -----------------------------------------------------------------------
  app.get<{ Querystring: { limit?: string } }>("/api/sessions", async (req, reply) => {
    const user = getUser(req);
    const rawLimit = parseInt(req.query.limit ?? "20", 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 20;

    const rows = await withUserContext(pool, user, (client) =>
      client
        .query<{
          id: string;
          last_finish_reason: string | null;
          awaiting_question: string | null;
          message_count: number;
          created_at: Date;
          updated_at: Date;
        }>(
          `SELECT id::text AS id,
                  last_finish_reason,
                  awaiting_question,
                  message_count,
                  created_at,
                  updated_at
             FROM agent_sessions
            ORDER BY updated_at DESC
            LIMIT $1`,
          [limit],
        )
        .then((r) => r.rows),
    );

    return reply.code(200).send({
      sessions: rows.map((r) => ({
        session_id: r.id,
        last_finish_reason: r.last_finish_reason,
        awaiting_question: r.awaiting_question,
        message_count: r.message_count,
        created_at: r.created_at.toISOString(),
        updated_at: r.updated_at.toISOString(),
      })),
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/sessions/:id/plan/run — Phase E chained execution.
  //
  // Loads the most-recent active plan for the session and runs harness
  // turns until the plan is completed, max_steps is hit, the auto-chain
  // cap fires, or the session-budget trips. Each turn appends to the
  // session's message history. Returns the final state.
  // -----------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/sessions/:id/plan/run", async (req, reply) => {
    if (!deps.config || !deps.llm || !deps.registry) {
      return reply.code(500).send({ error: "harness_deps_missing" });
    }
    const cfg = deps.config;
    const llm = deps.llm;
    const registry = deps.registry;

    const user = getUser(req);
    const sessionId = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
      return reply.code(400).send({ error: "invalid_input", detail: "session id must be a UUID" });
    }
    const plan = await loadActivePlanForSession(pool, user, sessionId);
    if (!plan) {
      return reply.code(404).send({ error: "no_active_plan" });
    }

    await advancePlan(pool, user, plan.id, { status: "running" });

    const result = await runChainedHarness({
      pool,
      user,
      sessionId,
      messages: plan.initialMessages,
      cfg,
      llm,
      registry,
      log: req.log,
    });

    // Mark plan as completed if the harness reported "stop", otherwise leave
    // it running for the next iteration.
    if (result.finalFinishReason === "stop") {
      await advancePlan(pool, user, plan.id, { status: "completed" });
    } else if (result.finalFinishReason === "session_budget_exceeded") {
      await advancePlan(pool, user, plan.id, { status: "failed" });
    }

    return reply.code(200).send({
      plan_id: plan.id,
      session_id: sessionId,
      auto_turns_used: result.autoTurns,
      final_finish_reason: result.finalFinishReason,
      total_steps_used: result.totalSteps,
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/sessions/:id/resume — Phase I auto-resume.
  //
  // Runs ONE more harness turn with a synthetic "Continue with the next
  // step on your todo list." user message. Used by the session_reanimator
  // cron to keep stalled sessions making progress without user interaction.
  //
  // Refuses when:
  //   - session.last_finish_reason = 'awaiting_user_input' (needs a real human)
  //   - session.auto_resume_count >= session.auto_resume_cap (loop guard)
  //   - session-budget tripped
  //
  // No admin gate here yet — operators control access via the cron's own
  // service role and an internal-only listener; if we expose this publicly
  // it'll need an `admin` role check via withUserContext.
  // -----------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/sessions/:id/resume", async (req, reply) => {
    if (!deps.config || !deps.llm || !deps.registry) {
      return reply.code(500).send({ error: "harness_deps_missing" });
    }
    const cfg = deps.config;
    const llm = deps.llm;
    const registry = deps.registry;

    const user = getUser(req);
    const sessionId = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
      return reply.code(400).send({ error: "invalid_input", detail: "session id must be a UUID" });
    }
    const state = await loadSession(pool, user, sessionId);
    if (!state) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (state.lastFinishReason === "awaiting_user_input") {
      return reply.code(409).send({
        error: "awaiting_user_input",
        detail: "session is paused on a clarifying question; needs a real user reply",
      });
    }
    if (state.autoResumeCount >= state.autoResumeCap) {
      return reply.code(409).send({
        error: "auto_resume_cap_reached",
        cap: state.autoResumeCap,
      });
    }

    // Synthetic user message — kept short + boring so it doesn't influence
    // the model's reasoning beyond "continue the plan you already have."
    const continueMessages: Message[] = [
      { role: "user", content: "Continue with the next step on your todo list. If everything is done, summarize and stop." },
    ];

    const result = await runChainedHarness({
      pool,
      user,
      sessionId,
      messages: continueMessages,
      cfg,
      llm,
      registry,
      log: req.log,
      maxAutoTurns: 1, // resume is one turn at a time; cron can call again
    });

    // Bump auto-resume counter after a successful run.
    await saveSession(pool, user, sessionId, {
      autoResumeCount: state.autoResumeCount + 1,
    });

    return reply.code(200).send({
      session_id: sessionId,
      final_finish_reason: result.finalFinishReason,
      total_steps_used: result.totalSteps,
      auto_resume_count: state.autoResumeCount + 1,
    });
  });
}

// ---------------------------------------------------------------------------
// Shared helper: run the harness one or more times against a session,
// auto-chaining until completion / max_steps cap / session-budget trip.
// ---------------------------------------------------------------------------

interface ChainedHarnessOptions {
  pool: Pool;
  user: string;
  sessionId: string;
  messages: Message[];
  cfg: Config;
  llm: LlmProvider;
  registry: ToolRegistry;
  log: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  maxAutoTurns?: number;
}

interface ChainedHarnessResult {
  autoTurns: number;
  totalSteps: number;
  finalFinishReason: string;
}

async function runChainedHarness(
  opts: ChainedHarnessOptions,
): Promise<ChainedHarnessResult> {
  const { pool, user, sessionId, cfg, llm, registry, log } = opts;
  const cap = opts.maxAutoTurns ?? cfg.AGENT_PLAN_MAX_AUTO_TURNS;

  const tools = registry.all();
  let autoTurns = 0;
  let totalSteps = 0;
  let finalFinishReason = "stop";
  let currentMessages = opts.messages;

  while (autoTurns < cap) {
    autoTurns++;

    // Reload session each turn so we have fresh budget totals + etag.
    const state = await loadSession(pool, user, sessionId);
    if (!state) {
      finalFinishReason = "session_lost";
      break;
    }

    const ctx: ToolContext = {
      userEntraId: user,
      seenFactIds: new Set<string>(
        Array.isArray(state.scratchpad["seenFactIds"])
          ? (state.scratchpad["seenFactIds"] as string[])
          : [],
      ),
      scratchpad: hydrateScratchpad(state.scratchpad, sessionId, cfg.AGENT_TOKEN_BUDGET),
    };

    const lifecycle = new Lifecycle();
    registerRedactSecretsHook(lifecycle);
    registerTagMaturityHook(lifecycle);
    registerBudgetGuardHook(lifecycle);

    const budget = new Budget({
      maxSteps: cfg.AGENT_CHAT_MAX_STEPS,
      maxPromptTokens: cfg.AGENT_TOKEN_BUDGET,
      session: {
        inputUsed: state.sessionInputTokens,
        outputUsed: state.sessionOutputTokens,
        inputCap:
          state.sessionTokenBudget ?? cfg.AGENT_SESSION_INPUT_TOKEN_BUDGET,
        outputCap: cfg.AGENT_SESSION_OUTPUT_TOKEN_BUDGET,
      },
    });

    try {
      const r = await runHarness({
        messages: currentMessages,
        tools,
        llm,
        budget,
        lifecycle,
        ctx,
      });
      totalSteps += r.stepsUsed;
      finalFinishReason = r.finishReason;

      // Persist updated session state.
      const sessTotals = budget.sessionTotals();
      const dump: Record<string, unknown> = {};
      for (const [k, v] of ctx.scratchpad.entries()) {
        if (k === "budget") continue;
        dump[k] = v instanceof Set ? Array.from(v) : v;
      }
      await saveSession(pool, user, sessionId, {
        scratchpad: dump,
        lastFinishReason: r.finishReason as SessionFinishReason,
        messageCount: currentMessages.length,
        sessionInputTokens: sessTotals?.inputTokens,
        sessionOutputTokens: sessTotals?.outputTokens,
        sessionSteps: state.sessionSteps + r.stepsUsed,
        expectedEtag: state.etag,
      });

      // Termination conditions.
      if (r.finishReason === "stop") break;
      if (r.finishReason === "awaiting_user_input") break;
      // Otherwise (max_steps), feed a one-line continue prompt and loop again.
      currentMessages = [
        { role: "user", content: "Continue from the last step. Stop when the plan is complete." },
      ];
    } catch (err) {
      // Use instanceof checks rather than err.name string-compares so a class
      // rename / minification can't silently change classification.
      if (err instanceof AwaitingUserInputError) {
        // ask_user fired: the harness threw because the LLM legitimately
        // asked for clarification. The runHarness finally already ran
        // post_turn (which persists awaiting_question). Stop chaining —
        // a real human reply is required to resume.
        finalFinishReason = "awaiting_user_input";
      } else if (err instanceof SessionBudgetExceededError) {
        finalFinishReason = "session_budget_exceeded";
      } else if (err instanceof BudgetExceededError) {
        // Per-turn budget overrun is recoverable — the next chained
        // iteration starts with a fresh per-turn budget. Map to max_steps
        // so the existing termination logic decides whether to chain again.
        finalFinishReason = "max_steps";
      } else if (err instanceof OptimisticLockError) {
        finalFinishReason = "concurrent_modification";
      } else {
        finalFinishReason = "error";
        log.error({ err }, "runChainedHarness: harness threw");
      }
      break;
    }
  }

  return { autoTurns, totalSteps, finalFinishReason };
}

function hydrateScratchpad(
  prior: Record<string, unknown>,
  sessionId: string,
  tokenBudget: number,
): Map<string, unknown> {
  const scratchpad = new Map<string, unknown>();
  for (const [k, v] of Object.entries(prior)) {
    if (k === "seenFactIds" || k === "budget") continue;
    scratchpad.set(k, v);
  }
  scratchpad.set("budget", {
    promptTokensUsed: 0,
    completionTokensUsed: 0,
    tokenBudget,
  });
  scratchpad.set("session_id", sessionId);
  return scratchpad;
}
