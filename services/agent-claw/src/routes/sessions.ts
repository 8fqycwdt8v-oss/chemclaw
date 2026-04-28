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
  tryIncrementAutoResumeCount,
  OptimisticLockError,
  type SessionFinishReason,
} from "../core/session-store.js";
import {
  loadActivePlanForSession,
  advancePlan,
} from "../core/plan-store-db.js";
import { withUserContext } from "../db/with-user-context.js";
import {
  Budget,
  BudgetExceededError,
  SessionBudgetExceededError,
} from "../core/budget.js";
import { runHarness } from "../core/harness.js";
import { AwaitingUserInputError } from "../tools/builtins/ask_user.js";
import { hydrateScratchpad } from "../core/session-state.js";
import { lifecycle } from "../core/runtime.js";
import { runWithRequestContext } from "../core/request-context.js";
import { verifyBearerHeader, McpAuthError } from "../security/mcp-tokens.js";
import {
  PaperclipClient,
  PaperclipBudgetError,
  USD_PER_TOKEN_ESTIMATE,
  type ReservationHandle,
} from "../core/paperclip-client.js";
import type { Message, ToolContext } from "../core/types.js";

interface SessionsRouteDeps {
  pool: Pool;
  getUser: (req: FastifyRequest) => string;
  // The chained-run + resume endpoints need the harness deps.
  config?: Config;
  llm?: LlmProvider;
  registry?: ToolRegistry;
  promptRegistry?: PromptRegistry;
  /** Paperclip-lite client. When supplied, every chained-harness iteration
   *  reserves and releases budget against the sidecar — without this, long
   *  auto-resume chains can blow past the daily USD cap with no 429.
   *  Mirrors the wiring in services/agent-claw/src/routes/chat.ts. */
  paperclip?: PaperclipClient;
}

export function registerSessionsRoute(
  app: FastifyInstance,
  deps: SessionsRouteDeps,
): void {
  const { pool, getUser } = deps;

  // Per-route rate-limit config for the mutating session endpoints.
  // /plan/run can chain up to AGENT_PLAN_MAX_AUTO_TURNS harness iterations
  // per call, so we want a tighter cap than the global rate limit. Default
  // to 1/4 of the chat limit (e.g. 7/min if chat is 30/min).
  const sessionMutatingRateLimit = deps.config
    ? {
        config: {
          rateLimit: {
            max: Math.max(1, Math.floor(deps.config.AGENT_CHAT_RATE_LIMIT_MAX / 4)),
            timeWindow: deps.config.AGENT_CHAT_RATE_LIMIT_WINDOW_MS,
          },
        },
      }
    : {};
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
  app.post<{ Params: { id: string } }>("/api/sessions/:id/plan/run", sessionMutatingRateLimit, async (req, reply) => {
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
      paperclip: deps.paperclip,
      log: req.log,
      // Phase F4: pass the plan so the runner can advance current_step_index
      // as tool calls match planned steps.
      planForProgress: {
        id: plan.id,
        steps: plan.steps,
        initialIndex: plan.currentStepIndex,
      },
    });

    // Mark plan as completed if the harness reported "stop", otherwise leave
    // it running for the next iteration.
    const finalIndex = result.planFinalStepIndex ?? plan.currentStepIndex;
    if (result.finalFinishReason === "stop") {
      // If we actually walked to the last step, mark completed; otherwise
      // the model "stopped" early — keep it running for a future call.
      const status = finalIndex >= plan.steps.length ? "completed" : "running";
      await advancePlan(pool, user, plan.id, {
        currentStepIndex: finalIndex,
        status,
      });
    } else if (result.finalFinishReason === "session_budget_exceeded") {
      await advancePlan(pool, user, plan.id, {
        currentStepIndex: finalIndex,
        status: "failed",
      });
    } else {
      // max_steps / awaiting_user_input / etc — persist progress, keep open.
      await advancePlan(pool, user, plan.id, { currentStepIndex: finalIndex });
    }

    return reply.code(200).send({
      plan_id: plan.id,
      session_id: sessionId,
      auto_turns_used: result.autoTurns,
      final_finish_reason: result.finalFinishReason,
      total_steps_used: result.totalSteps,
      // Plan progress info — clients render this as a "X of N steps" badge.
      plan_progress: {
        current_step_index: finalIndex,
        total_steps: plan.steps.length,
      },
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
  app.post<{ Params: { id: string } }>("/api/sessions/:id/resume", sessionMutatingRateLimit, async (req, reply) => {
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
    // Atomic counter increment + cap check + awaiting-user-input guard.
    // Doing this BEFORE the harness run means:
    //   - Two parallel reanimator calls can't both pass the cap check
    //   - A crash mid-harness still leaves the count bumped (the next tick
    //     sees the correct value rather than re-firing)
    //   - The awaiting_user_input check is enforced in SQL, not JS
    const newCount = await tryIncrementAutoResumeCount(pool, user, sessionId);
    if (newCount === null) {
      // Either cap reached, awaiting_user_input set, or row missing — read
      // the row again to give a precise reason to the caller.
      const after = await loadSession(pool, user, sessionId);
      if (!after) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (after.lastFinishReason === "awaiting_user_input") {
        return reply.code(409).send({
          error: "awaiting_user_input",
          detail: "session is paused on a clarifying question; needs a real user reply",
        });
      }
      return reply.code(409).send({
        error: "auto_resume_cap_reached",
        cap: after.autoResumeCap,
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
      paperclip: deps.paperclip,
      log: req.log,
      maxAutoTurns: 1, // resume is one turn at a time; cron can call again
    });

    return reply.code(200).send({
      session_id: sessionId,
      final_finish_reason: result.finalFinishReason,
      total_steps_used: result.totalSteps,
      auto_resume_count: newCount,
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/internal/sessions/:id/resume — JWT-authenticated auto-resume.
  //
  // The reanimator daemon (services/optimizer/session_reanimator/) calls
  // this with a Bearer JWT signed by MCP_AUTH_SIGNING_KEY. The token's
  // `user` claim names the session's owning user — that becomes the RLS
  // scope for this turn. No header trust: we read user identity from the
  // signed claims, not from x-user-entra-id.
  //
  // Required scope: "agent:resume". Other internal callers can be added
  // later by minting tokens with different scopes (e.g. "agent:summarize"
  // for a future summary daemon).
  // -----------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/internal/sessions/:id/resume", sessionMutatingRateLimit, async (req, reply) => {
    if (!deps.config || !deps.llm || !deps.registry) {
      return reply.code(500).send({ error: "harness_deps_missing" });
    }
    const cfg = deps.config;
    const llm = deps.llm;
    const registry = deps.registry;

    // Verify the JWT.
    const authz = req.headers["authorization"];
    let claimedUser: string;
    try {
      const claims = verifyBearerHeader(typeof authz === "string" ? authz : undefined, {
        requiredScope: "agent:resume",
      });
      if (!claims) {
        return reply.code(401).send({
          error: "unauthenticated",
          detail: "Authorization: Bearer <jwt> required",
        });
      }
      claimedUser = claims.user;
    } catch (err) {
      if (err instanceof McpAuthError) {
        return reply.code(401).send({
          error: "unauthenticated",
          detail: err.message,
        });
      }
      throw err;
    }

    const sessionId = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
      return reply.code(400).send({ error: "invalid_input", detail: "session id must be a UUID" });
    }
    // Atomic counter + cap + awaiting check (same pattern as the public
    // route). The harness only runs if the increment succeeded.
    const newCount = await tryIncrementAutoResumeCount(pool, claimedUser, sessionId);
    if (newCount === null) {
      const after = await loadSession(pool, claimedUser, sessionId);
      if (!after) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (after.lastFinishReason === "awaiting_user_input") {
        return reply.code(409).send({
          error: "awaiting_user_input",
          detail: "session is paused on a clarifying question; needs a real user reply",
        });
      }
      return reply.code(409).send({
        error: "auto_resume_cap_reached",
        cap: after.autoResumeCap,
      });
    }

    const continueMessages: Message[] = [
      { role: "user", content: "Continue with the next step on your todo list. If everything is done, summarize and stop." },
    ];

    const result = await runChainedHarness({
      pool,
      user: claimedUser,
      sessionId,
      messages: continueMessages,
      cfg,
      llm,
      registry,
      paperclip: deps.paperclip,
      log: req.log,
      maxAutoTurns: 1,
    });

    return reply.code(200).send({
      session_id: sessionId,
      final_finish_reason: result.finalFinishReason,
      total_steps_used: result.totalSteps,
      auto_resume_count: newCount,
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
  /** Per-iteration Paperclip reservation — required to keep daily-USD caps
   *  enforced for chained-execution flows (plan/run + resume), parallel to
   *  chat.ts. When omitted (PAPERCLIP_URL unset in dev), the in-process
   *  Budget cap is the only gate. */
  paperclip?: PaperclipClient;
  /** Phase F4 — when set, the runner advances `current_step_index` as tool
   * calls match planned step.tool names. Result includes the final index. */
  planForProgress?: {
    id: string;
    steps: ReadonlyArray<{ readonly tool: string }>;
    initialIndex: number;
  };
}

interface ChainedHarnessResult {
  autoTurns: number;
  totalSteps: number;
  finalFinishReason: string;
  /** Phase F4 — final current_step_index when planForProgress was supplied. */
  planFinalStepIndex?: number;
}

async function runChainedHarness(
  opts: ChainedHarnessOptions,
): Promise<ChainedHarnessResult> {
  // Establish the AsyncLocalStorage context so every outbound MCP call
  // tags itself with the right user's identity. The chained-execution and
  // resume endpoints both call this helper, so doing it here covers both.
  return runWithRequestContext(
    { userEntraId: opts.user, sessionId: opts.sessionId },
    () => _runChainedHarnessInner(opts),
  );
}

async function _runChainedHarnessInner(
  opts: ChainedHarnessOptions,
): Promise<ChainedHarnessResult> {
  const { pool, user, sessionId, cfg, llm, registry, log } = opts;
  const cap = opts.maxAutoTurns ?? cfg.AGENT_PLAN_MAX_AUTO_TURNS;

  const tools = registry.all();
  let autoTurns = 0;
  let totalSteps = 0;
  let finalFinishReason = "stop";
  let currentMessages = opts.messages;
  // Phase 4B: track whether we've fired session_start for this chain. The
  // chained-run + resume routes both target an existing session row, so
  // source="resume". We only need to fire once per call (not per chained
  // turn) — runHarness's own pre_turn handles the per-turn entry events.
  let sessionStartFired = false;
  // Plan progress tracking: walk through the recorded tool messages added
  // by each iteration and advance current_step_index when the toolId
  // matches plan.steps[currentStepIndex].tool. Exact-match for first cut;
  // semantic matching is a follow-up.
  let planStepIndex = opts.planForProgress?.initialIndex ?? 0;
  // Track which messages we've already inspected so re-iteration doesn't
  // double-count tool calls (the harness mutates `currentMessages` in place).
  let inspectedUpTo = 0;

  while (autoTurns < cap) {
    autoTurns++;

    // Reload session each turn so we have fresh budget totals + etag.
    const state = await loadSession(pool, user, sessionId);
    if (!state) {
      finalFinishReason = "session_lost";
      break;
    }

    // Per-iteration Paperclip reservation. Mirrors chat.ts so the daily
    // USD cap applies equally to chained-execution flows. A budget refusal
    // ends the chain (rather than the whole request) — the user can retry
    // at the next budget window. Network/5xx are non-fatal: log + continue.
    let paperclipHandle: ReservationHandle | null = null;
    if (opts.paperclip) {
      try {
        paperclipHandle = await opts.paperclip.reserve({
          userEntraId: user,
          sessionId,
          estTokens: 12_000,
          estUsd: 0.05,
        });
      } catch (err) {
        if (err instanceof PaperclipBudgetError) {
          finalFinishReason = "budget_exceeded";
          break;
        }
        log.warn({ err }, "paperclip /reserve failed in chained-harness (non-fatal)");
      }
    }

    const { scratchpad, seenFactIds } = hydrateScratchpad(
      state.scratchpad,
      sessionId,
      cfg.AGENT_TOKEN_BUDGET,
    );
    const ctx: ToolContext = { userEntraId: user, seenFactIds, scratchpad, lifecycle };

    // Phase 4B: dispatch session_start once at the top of the chain. Both
    // chain entry points (POST /plan/run and POST /resume) operate on a
    // pre-existing session row, so source="resume".
    if (!sessionStartFired) {
      sessionStartFired = true;
      try {
        await lifecycle.dispatch("session_start", {
          ctx,
          sessionId,
          source: "resume",
        });
      } catch (err) {
        log.warn({ err }, "session_start dispatch failed (non-fatal)");
      }
    }

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

      // Plan progress: walk the new tool messages added by this iteration.
      // Each tool message has role="tool" + toolId. We compare in order
      // against plan.steps[planStepIndex].tool and advance on each match.
      if (opts.planForProgress) {
        const steps = opts.planForProgress.steps;
        for (let i = inspectedUpTo; i < currentMessages.length; i++) {
          const m = currentMessages[i];
          if (
            m?.role === "tool" &&
            typeof m.toolId === "string" &&
            planStepIndex < steps.length &&
            m.toolId === steps[planStepIndex]?.tool
          ) {
            planStepIndex++;
          }
        }
        inspectedUpTo = currentMessages.length;
      }

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

      // Release this iteration's Paperclip reservation with TURN-DELTA
      // actuals (not session-cumulative). `r.usage` is `budget.summary()`
      // which returns just this iteration's prompt + completion tokens.
      // Using `sessTotals` here would re-report prior turns' tokens on
      // every iteration of the chain, causing the sidecar to over-count
      // and trip the daily cap early. The USD estimate is the shared
      // USD_PER_TOKEN_ESTIMATE constant (chat.ts uses the same).
      // Network/release failure is non-fatal — the reservation will
      // expire on its own TTL if /release never lands.
      if (paperclipHandle) {
        try {
          const totalTokens = r.usage.promptTokens + r.usage.completionTokens;
          const actualUsd = totalTokens * USD_PER_TOKEN_ESTIMATE;
          await paperclipHandle.release(totalTokens, actualUsd);
        } catch (relErr) {
          log.warn({ err: relErr }, "paperclip /release failed (non-fatal)");
        }
        paperclipHandle = null;
      }

      // Termination conditions.
      if (r.finishReason === "stop") break;
      if (r.finishReason === "awaiting_user_input") break;
      // Otherwise (max_steps), feed a one-line continue prompt and loop again.
      currentMessages = [
        { role: "user", content: "Continue from the last step. Stop when the plan is complete." },
      ];
      // Plan-progress walker: reset the inspection cursor since we just
      // replaced currentMessages with a fresh 1-element array. Without this
      // reset, the next iteration's `for (let i = inspectedUpTo; ...)` loop
      // starts at the OLD length (e.g. 50) but currentMessages.length is
      // now 1 — every tool call in the continuation turn is silently
      // skipped for plan progress, and current_step_index never advances.
      inspectedUpTo = 0;
    } catch (err) {
      // Release the reservation (best-effort) before classifying the error
      // so a crashing iteration doesn't leak a hold on Paperclip's per-day
      // budget for its whole TTL window.
      if (paperclipHandle) {
        try {
          await paperclipHandle.release(0, 0);
        } catch (relErr) {
          log.warn({ err: relErr }, "paperclip /release failed in catch (non-fatal)");
        }
        paperclipHandle = null;
      }
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

  // Phase 4B: session_end fires once at the end of the chain when the
  // final finish reason is a clean stop. Awaiting-input / budget-exceeded
  // leave the session open for the next reanimator tick or user message.
  //
  // GOTCHA for future hook authors: the `endCtx` synthesized here is
  // intentionally minimal — `seenFactIds` is empty and `scratchpad` is
  // empty. The chain persisted real state through `saveSession` after
  // each turn, but rebuilding ctx from disk for one terminal dispatch
  // would be expensive and is not currently worth the complexity. If
  // your `session_end` hook needs to read scratchpad, load it from the
  // `agent_sessions.scratchpad` row directly (see `loadSession` in
  // services/agent-claw/src/core/session-store.ts) — do NOT rely on
  // `endCtx.scratchpad` being populated.
  if (sessionStartFired && finalFinishReason === "stop") {
    try {
      const endCtx: ToolContext = {
        userEntraId: user,
        seenFactIds: new Set<string>(),
        scratchpad: new Map<string, unknown>(),
        lifecycle,
      };
      await lifecycle.dispatch("session_end", {
        ctx: endCtx,
        sessionId,
        finishReason: finalFinishReason,
      });
    } catch (err) {
      log.warn({ err }, "session_end dispatch failed (non-fatal)");
    }
  }

  return {
    autoTurns,
    totalSteps,
    finalFinishReason,
    planFinalStepIndex: opts.planForProgress ? planStepIndex : undefined,
  };
}

// hydrateScratchpad lives in core/session-state.ts so chat.ts and this
// file share the same hydration logic. The Lifecycle is sourced from
// core/runtime.ts — single instance populated once at startup by
// loadHooks() in index.ts; routes and sub-agents share it.
