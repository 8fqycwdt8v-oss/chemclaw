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
// SSE event union: see ../streaming/sse.ts (StreamEvent). Every turn ends with
// exactly one terminal event (`finish` or `error`).
//
// Defences:
//   - Dedicated lower rate limit (AGENT_CHAT_RATE_LIMIT_MAX).
//   - History cap (AGENT_CHAT_MAX_HISTORY) + per-message cap (AGENT_CHAT_MAX_INPUT_CHARS).
//   - Server-enforced maxSteps on the agent loop.
//   - Cross-turn session token budget (AGENT_TOKEN_BUDGET); breach → `error: session_budget_exceeded`.
//   - Terminal-event guarantee: finish or error always emitted.
//   - Plan mode: LLM asked to produce JSON plan; plan_step + plan_ready events emitted; no tools execute.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  Budget,
  BudgetExceededError,
  SessionBudgetExceededError,
  estimateTokenCount,
} from "../core/budget.js";
import { buildAgent, runHarness } from "../core/harness.js";
import {
  parseSlash,
  parseFeedbackArgs,
  shortCircuitResponse,
  HELP_TEXT,
} from "../core/slash.js";
import type { RedactReplacement } from "../core/hooks/redact-secrets.js";
import { hydrateScratchpad, persistTurnState } from "../core/session-state.js";
import { lifecycle } from "../core/runtime.js";
import {
  createSession,
  loadSession,
  saveSession,
  OptimisticLockError,
} from "../core/session-store.js";
import { savePlanForSession } from "../core/plan-store-db.js";
import { AwaitingUserInputError } from "../tools/builtins/ask_user.js";
import { runWithRequestContext } from "../core/request-context.js";
import { withUserContext } from "../db/with-user-context.js";
import { PromptRegistry } from "../prompts/registry.js";
import type {
  Message,
  PostCompactPayload,
  PreCompactPayload,
  ToolContext,
} from "../core/types.js";
import {
  planStore,
  createPlan,
  parsePlanSteps,
  PLAN_MODE_SYSTEM_SUFFIX,
} from "../core/plan-mode.js";
import type { SkillLoader } from "../core/skills.js";
import { VERB_TO_SKILL } from "../core/skills.js";
import { writeEvent, setupSse } from "../streaming/sse.js";
import { makeSseSink } from "../streaming/sse-sink.js";
import { startRootTurnSpan, recordLlmUsage, recordSpanError } from "../observability/spans.js";
import { context as otelContext, trace } from "@opentelemetry/api";
import {
  PaperclipClient,
  PaperclipBudgetError,
  USD_PER_TOKEN_ESTIMATE,
  type ReservationHandle,
} from "../core/paperclip-client.js";
import { ShadowEvaluator } from "../prompts/shadow-evaluator.js";
// Re-exported so existing imports `import type { StreamEvent } from "./chat.js"`
// keep compiling — the canonical home is now ../streaming/sse.ts.
export type { StreamEvent } from "../streaming/sse.js";

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
      [userEntraId, signal, reason ?? null, traceId ?? null],
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

  // ── Skill activation for this turn ──────────────────────────────────────
  // If the slash verb implies a skill (e.g. /dr → deep_research), activate it
  // for this turn only (non-persistent). Persistent enable/disable goes through
  // POST /api/skills/enable|disable.
  const loader = deps.skillLoader;
  let cleanupSkillForTurn: (() => void) | undefined;
  if (loader && slashResult.verb) {
    const impliedSkill = VERB_TO_SKILL[slashResult.verb];
    if (impliedSkill && loader.has(impliedSkill)) {
      cleanupSkillForTurn = loader.enableForTurn(impliedSkill);
    }
  }

  // Build system prompt: base + active-skill prompts + plan-mode suffix.
  let systemPrompt = "";
  let activePromptVersion: number | undefined;
  try {
    try {
      const active = await deps.promptRegistry.getActive("agent.system");
      systemPrompt = active.template;
      activePromptVersion = active.version;
    } catch {
      req.log.warn("agent.system prompt not found in prompt_registry; using minimal fallback");
      systemPrompt = "You are ChemClaw, an autonomous chemistry knowledge agent.";
    }
  } catch (err) {
    req.log.error({ err }, "failed to load system prompt");
    systemPrompt = "You are ChemClaw, an autonomous chemistry knowledge agent.";
  }

  // Prepend active-skill prompts.
  if (loader && loader.activeIds.size > 0) {
    systemPrompt = loader.buildSystemPrompt(systemPrompt);
  }

  // Append plan-mode instructions.
  if (isPlanMode) {
    systemPrompt = systemPrompt + PLAN_MODE_SYSTEM_SUFFIX;
  }

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    ...body.messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolId: m.toolId,
    })),
  ];

  // ── Session: load existing or create fresh. ───────────────────────────────
  // If the client supplied session_id, load the prior scratchpad and clear
  // any awaiting_question (the new user message IS the answer). If not,
  // mint a new session — the SSE path emits a `session` event so the client
  // can resume on the next turn.
  let sessionId: string | null = body.session_id ?? null;
  // Phase 4B: track whether the session existed at the start of this turn
  // so the session_start dispatch can pass source ∈ {"create", "resume"}.
  let sessionExisted = false;
  let priorScratchpad: Record<string, unknown> = {};
  // Phase F + H state captured at turn start.
  let sessionEtag: string | undefined;
  let sessionInputUsed = 0;
  let sessionOutputUsed = 0;
  let sessionStepsUsed = 0;
  let sessionInputCap = deps.config.AGENT_SESSION_INPUT_TOKEN_BUDGET;
  const sessionOutputCap = deps.config.AGENT_SESSION_OUTPUT_TOKEN_BUDGET;
  if (sessionId) {
    try {
      const loaded = await loadSession(deps.pool, user, sessionId);
      if (loaded) {
        sessionExisted = true;
        priorScratchpad = loaded.scratchpad ?? {};
        sessionEtag = loaded.etag;
        sessionInputUsed = loaded.sessionInputTokens;
        sessionOutputUsed = loaded.sessionOutputTokens;
        sessionStepsUsed = loaded.sessionSteps;
        if (loaded.sessionTokenBudget != null) {
          sessionInputCap = loaded.sessionTokenBudget;
          // Output budget defaults to 1/5 of input cap unless overridden via env.
          // (Per-session override of the output cap is a follow-up.)
        }
        // Clear awaiting_question — the just-arrived message answers it.
        // Use the loaded etag so we don't race a concurrent saveSession.
        const saved = await saveSession(deps.pool, user, sessionId, {
          awaitingQuestion: null,
          expectedEtag: loaded.etag,
        });
        sessionEtag = saved.etag;
      } else {
        // Unknown session id: ignore and treat as a fresh session. This is
        // a legitimate "row doesn't exist or wasn't visible to this user"
        // case (e.g., session expired, or wrong tenant).
        sessionId = null;
      }
    } catch (err) {
      // loadSession threw — that's a DB / RLS / connectivity error, not a
      // missing-row case. Log at error level so misconfiguration is visible
      // (e.g., chemclaw_app role missing FORCE-RLS bypass would cause every
      // load to fail and every chat to silently lose continuity). We still
      // fall through to "fresh session" so the user gets a working response,
      // but the loud log makes the bug findable.
      req.log.error({ err, sessionId }, "loadSession threw — DB/RLS error; treating as fresh");
      sessionId = null;
    }
  }
  if (!sessionId) {
    try {
      sessionId = await createSession(deps.pool, user);
    } catch (err) {
      // Non-fatal: if session creation fails the agent can still serve the
      // turn statelessly. Log and proceed.
      req.log.warn({ err }, "createSession failed; continuing without session");
    }
  }

  const { scratchpad, seenFactIds } = hydrateScratchpad(
    priorScratchpad,
    sessionId,
    deps.config.AGENT_TOKEN_BUDGET,
  );
  const ctx: ToolContext = {
    userEntraId: user,
    seenFactIds,
    scratchpad,
    lifecycle,
  };

  // ── Phase 4B lifecycle dispatches ──────────────────────────────────────
  // user_prompt_submit fires after ctx is built but before slash-mode
  // branches (manual /compact, /plan) and before runHarness. session_start
  // fires next, with source ∈ {"create", "resume"} based on whether the
  // session row existed at the start of this turn. Both are best-effort:
  // failures are logged and don't abort the turn.
  try {
    await lifecycle.dispatch("user_prompt_submit", {
      ctx,
      prompt: lastUserMessage?.content ?? "",
      sessionId,
    });
  } catch (err) {
    req.log.warn({ err }, "user_prompt_submit dispatch failed (non-fatal)");
  }

  if (sessionId) {
    try {
      await lifecycle.dispatch("session_start", {
        ctx,
        sessionId,
        source: sessionExisted ? "resume" : "create",
      });
    } catch (err) {
      req.log.warn({ err }, "session_start dispatch failed (non-fatal)");
    }
  }

  // ── Manual /compact slash branch ────────────────────────────────────────
  // Fires pre_compact (with trigger="manual" and any user-supplied
  // summarization steering) BEFORE the normal harness turn. The
  // compact-window hook mutates `messages` in place; the harness then runs
  // against the compacted window. This is the user-driven counterpart to
  // the auto path inside runHarness's loop.
  if (slashResult.verb === "compact") {
    const customInstructions = slashResult.args.trim() || null;
    const preTokens = estimateTokenCount(messages);
    const prePayload: PreCompactPayload = {
      ctx,
      messages,
      trigger: "manual",
      pre_tokens: preTokens,
      custom_instructions: customInstructions,
    };
    try {
      await lifecycle.dispatch("pre_compact", prePayload);
      const postTokens = estimateTokenCount(messages);
      const postPayload: PostCompactPayload = {
        ctx,
        trigger: "manual",
        pre_tokens: preTokens,
        post_tokens: postTokens,
      };
      await lifecycle.dispatch("post_compact", postPayload);
    } catch (err) {
      // Compaction itself shouldn't abort the turn — log and proceed with
      // the original message window.
      req.log.warn({ err }, "manual /compact dispatch failed; proceeding uncompacted");
    }
  }

  // Filter tools by active skills (if any skills are active).
  const allTools = deps.registry.all();
  const tools = loader ? loader.filterTools(allTools) : allTools;

  // Use max_steps_override from active skills if set.
  const skillMaxSteps = loader?.maxStepsOverride();
  const effectiveMaxSteps = skillMaxSteps ?? deps.config.AGENT_CHAT_MAX_STEPS;

  const agent = buildAgent({
    llm: deps.llm,
    tools,
    lifecycle,
    maxSteps: effectiveMaxSteps,
    maxPromptTokens: deps.config.AGENT_TOKEN_BUDGET,
  });

  // ------- Paperclip reservation (Phase D) — applies to BOTH streaming and
  // non-streaming paths so daily-USD enforcement is uniform. A budget refusal
  // surfaces as HTTP 429 with Retry-After before any response body opens.
  let paperclipHandle: ReservationHandle | null = null;
  if (deps.paperclip) {
    try {
      paperclipHandle = await deps.paperclip.reserve({
        userEntraId: user,
        sessionId: sessionId ?? "stateless",
        estTokens: 12_000,
        estUsd: 0.05,
      });
    } catch (err: unknown) {
      if (err instanceof PaperclipBudgetError) {
        cleanupSkillForTurn?.();
        return void reply
          .code(429)
          .header("Retry-After", String(err.retryAfterSeconds))
          .send({
            error: "budget_exceeded",
            reason: err.reason,
            retry_after_seconds: err.retryAfterSeconds,
          });
      }
      req.log.warn({ err }, "paperclip /reserve failed (non-fatal)");
    }
  }

  // Open the OTel root span for the turn — emits the Langfuse `prompt:<name>`
  // tag so the GEPA runner's tag-filtered fetch returns this trace. Opened
  // BEFORE the doStream branch so both paths inherit the same span context
  // (plan-mode / non-streaming completeJson calls inherit via context.with()
  // below).
  const rootSpan = startRootTurnSpan({
    traceId: body.agent_trace_id ?? sessionId ?? "unknown",
    userEntraId: user,
    model: deps.config.AGENT_MODEL,
    promptName: "agent.system",
    promptVersion: activePromptVersion,
    sessionId: sessionId ?? undefined,
  });

  // Helper: release Paperclip + close root span. Called from the non-streaming
  // path's success / error returns; the streaming path has its own finally
  // block that does the same work plus session persistence + post_turn.
  const closeNonStreamingTurn = async (
    promptTokens: number,
    completionTokens: number,
  ) => {
    try {
      recordLlmUsage(rootSpan, {
        promptTokens,
        completionTokens,
        model: deps.config.AGENT_MODEL,
      });
    } catch (spanErr) {
      try { recordSpanError(rootSpan, spanErr); } catch { /* ignore */ }
    }
    try { rootSpan.end(); } catch { /* ignore */ }

    if (paperclipHandle) {
      try {
        const totalTokens = promptTokens + completionTokens;
        const actualUsd = totalTokens * USD_PER_TOKEN_ESTIMATE;
        await paperclipHandle.release(totalTokens, actualUsd);
      } catch (relErr) {
        req.log.warn({ err: relErr }, "paperclip /release failed (non-fatal)");
      }
    }
  };

  if (!doStream) {
    // Non-streaming path. Mirrors the streaming path's Paperclip + rootSpan
    // wiring so daily-USD caps and Langfuse trace tagging apply uniformly.
    try {
      if (isPlanMode) {
        // Plan mode: ask LLM to produce a JSON plan; no tool execution.
        // Run the completeJson call inside the rootSpan's OTel context so
        // LiteLLM's auto-instrumentation parents its trace under the
        // root and inherits the prompt:agent.system tag (deep-review #6).
        const planJson = await otelContext.with(
          trace.setSpan(otelContext.active(), rootSpan),
          () =>
            deps.llm.completeJson({
              system: systemPrompt,
              user: lastUserMessage?.content ?? "",
            }),
        );
        const steps = parsePlanSteps(planJson);
        const plan = createPlan(steps, messages, user);
        planStore.save(plan);
        cleanupSkillForTurn?.();
        await closeNonStreamingTurn(0, 0);
        return void reply.send({
          plan_id: plan.plan_id,
          steps: plan.steps,
          created_at: plan.created_at,
        });
      }
      const result = await otelContext.with(
        trace.setSpan(otelContext.active(), rootSpan),
        () => agent.run({ messages, ctx }),
      );
      cleanupSkillForTurn?.();
      await closeNonStreamingTurn(result.usage.promptTokens, result.usage.completionTokens);
      return void reply.send({ text: result.text, finishReason: result.finishReason, usage: result.usage });
    } catch (err) {
      req.log.error({ err }, "chat generate failed");
      cleanupSkillForTurn?.();
      try { recordSpanError(rootSpan, err); } catch { /* ignore */ }
      await closeNonStreamingTurn(0, 0);
      return void reply.code(500).send({ error: "internal" });
    }
  }

  // ------- SSE streaming path -------
  setupSse(reply);

  // NOTE: onSession fires BEFORE pre_turn (when both streamSink and
  // sessionId are set) — runHarness drives the `session` SSE event via the
  // sink. We do NOT emit it here directly — that would double-fire when
  // runHarness runs.

  let closed = false;
  const onClose = () => { closed = true; };
  req.raw.on("close", onClose);
  req.raw.on("aborted", onClose);

  // finishReason and budget are hoisted out of the try block so the finally
  // can read them when the loop exits via error. Mirrors runHarness() in
  // core/harness.ts.
  let finishReason = "stop";
  // Streaming redaction log: each text_delta is scrubbed in flight via the
  // sink's onTextDelta (makeSseSink wraps redactString); replacements
  // accumulate here so the route's finally can persist them to scratchpad
  // for observability.
  //
  // TODO(disconnect-mid-stream): runHarness doesn't accept an AbortSignal,
  // so a client close mid-stream cannot abort the harness loop. Writes to
  // a closed reply silently no-op via Fastify, but the LLM call (and any
  // outstanding tool calls) run to completion. A future phase should plumb
  // an AbortController through runHarness if mid-stream cost becomes an
  // issue.
  const _streamRedactions: RedactReplacement[] = [];
  let budget: Budget | undefined;

  // Make rootSpan the active OTel context for the rest of the turn so
  // every LiteLLM auto-instrumented call inherits the parent and the
  // `prompt:agent.system` tag. The AsyncLocalStorageContextManager
  // registered in observability/otel.ts propagates this across awaits.
  const turnCtx = trace.setSpan(otelContext.active(), rootSpan);
  try {
    // Plan mode: ask LLM for a JSON plan; emit plan_step + plan_ready; no tool execution.
    if (isPlanMode) {
      try {
        const planJson = await otelContext.with(turnCtx, () =>
          deps.llm.completeJson({
            system: systemPrompt,
            user: lastUserMessage?.content ?? "",
          }),
        );
        const steps = parsePlanSteps(planJson);

        // Emit plan_step events.
        for (const step of steps) {
          if (closed) break;
          writeEvent(reply, {
            type: "plan_step",
            step_number: step.step_number,
            tool: step.tool,
            args: step.args,
            rationale: step.rationale,
          });
        }

        // Save the plan to:
        //   1. The legacy in-memory planStore — kept for backward-compat with
        //      /api/chat/plan/approve and existing tests.
        //   2. The DB-backed agent_plans table — used by Phase E chained
        //      execution via /api/sessions/:id/plan/run.
        const plan = createPlan(steps, messages, user);
        planStore.save(plan);

        // DB persistence requires a session id. If we couldn't create one
        // earlier, the plan is in-memory only and the chained-run endpoint
        // won't find it — fine, the legacy approve path still works.
        if (sessionId) {
          try {
            await savePlanForSession(deps.pool, user, sessionId, steps, messages);
          } catch (err) {
            req.log.warn({ err }, "savePlanForSession failed; falling back to in-memory");
          }
        }

        if (!closed) {
          writeEvent(reply, {
            type: "plan_ready",
            plan_id: plan.plan_id,
            steps: plan.steps,
            created_at: plan.created_at,
          });
          writeEvent(reply, {
            type: "finish",
            finishReason: "plan_ready",
            usage: { promptTokens: 0, completionTokens: 0 },
          });
        }
        // Reflect plan-ready into the local var so the outer finally's
        // saveSession + shadow-eval gate see the correct terminal state.
        finishReason = "plan_ready";
      } catch (err) {
        req.log.error({ err }, "plan-mode failed");
        if (!closed) writeEvent(reply, { type: "error", error: "plan_mode_failed" });
      } finally {
        cleanupSkillForTurn?.();
        try { reply.raw.end(); } catch { /* already closed */ }
      }
      return;
    }

    // Token-by-token streaming path — delegated to runHarness with an SSE sink.
    //
    // Phase 2B: this used to be a hand-rolled while-loop that duplicated the
    // pre_turn / pre_tool / post_tool / post_turn dispatches and emitted SSE
    // events inline. All of that now lives in core/harness.ts; the sink
    // converts StreamSink callbacks into wire frames via streaming/sse-sink.ts.
    //
    // The sink does NOT expose onAwaitingUserInput — the route's finally
    // block below lifts the awaiting_question from scratchpad, redacts it,
    // persists it to the session row, and emits the SSE event. Wiring the
    // sink's onAwaitingUserInput would emit an unredacted question before
    // the session save, which is the wrong order for both the wire and the DB.
    //
    // Likewise the sink does NOT expose onFinish — the route's finally
    // emits `finish` AFTER the saveSession + awaiting_user_input emit, which
    // is part of the public SSE wire contract. (The harness's onFinish is
    // a no-op when the sink omits the callback.)
    const sink = makeSseSink(reply, _streamRedactions, sessionId ?? undefined);
    // Strip the two callbacks the route owns. The sink object is freshly
    // built here so deleting on it doesn't leak anywhere else.
    delete (sink as { onAwaitingUserInput?: unknown }).onAwaitingUserInput;
    delete (sink as { onFinish?: unknown }).onFinish;

    budget = new Budget({
      maxSteps: effectiveMaxSteps,
      maxPromptTokens: deps.config.AGENT_TOKEN_BUDGET,
      // Phase F: charge against the session-level cap on every step.
      // sessionId being null means stateless — skip the session cap.
      session: sessionId
        ? {
            inputUsed: sessionInputUsed,
            outputUsed: sessionOutputUsed,
            inputCap: sessionInputCap,
            outputCap: sessionOutputCap,
          }
        : undefined,
    });

    const result = await runHarness({
      messages,
      tools,
      llm: deps.llm,
      budget,
      lifecycle,
      ctx,
      streamSink: sink,
      sessionId: sessionId ?? undefined,
    });

    // v1.2 collapse: the hand-rolled call()→streamCompletion()→pre_tool /
    // post_tool / todo_update wiring that previously lived here was deleted
    // when runHarness became the single source of truth for the loop. All
    // those dispatches happen inside runHarness now, and the SSE adapter
    // (makeSseSink) translates StreamSink callbacks into the same wire
    // events. Keep the route handler short — see ADR 008.
    finishReason = result.finishReason;
  } catch (err) {
    // Distinguish typed control-flow / quota errors so clients can render
    // appropriate UI. instanceof checks instead of err.name strings —
    // safer under minification and rename refactors.
    if (err instanceof SessionBudgetExceededError) {
      req.log.warn({ err }, "chat stream stopped: session budget exceeded");
      finishReason = "session_budget_exceeded";
      if (!closed) {
        writeEvent(reply, { type: "error", error: "session_budget_exceeded" });
      }
    } else if (err instanceof BudgetExceededError) {
      // Per-turn budget overrun. runHarness sets finishReason="budget_exceeded"
      // and re-throws so the route can render a typed error event. Before
      // Phase 2B this branch was unreachable because chat.ts checked the
      // step cap manually and the prompt-token cap path was caught by the
      // generic else below.
      req.log.warn({ err }, "chat stream stopped: per-turn budget exceeded");
      finishReason = "budget_exceeded";
      if (!closed) {
        writeEvent(reply, { type: "error", error: "budget_exceeded" });
      }
    } else if (err instanceof OptimisticLockError) {
      req.log.warn({ err }, "chat stream stopped: concurrent modification");
      finishReason = "concurrent_modification";
      if (!closed) {
        writeEvent(reply, { type: "error", error: "concurrent_modification" });
      }
    } else if (err instanceof AwaitingUserInputError) {
      // runHarness re-throws AwaitingUserInputError after dispatching
      // post_turn (which persists the awaiting_question to scratchpad).
      // Treat as a normal awaiting-input exit, NOT an error — the route's
      // finally block lifts the question from scratchpad and emits the
      // awaiting_user_input SSE event.
      finishReason = "awaiting_user_input";
    } else {
      req.log.error({ err }, "chat stream failed");
      if (!closed) {
        writeEvent(reply, { type: "error", error: "internal" });
      }
    }
  } finally {
    // Persist in-flight stream redactions to scratchpad for observability.
    // post_turn already ran inside runHarness; we append the stream_delta
    // log entry AFTER the post_turn redact-secrets entry. The two are
    // independent — redact-secrets reads/writes its own entry from finalText,
    // we append ours from the per-delta scrubs the SSE sink performed.
    if (_streamRedactions.length > 0) {
      try {
        const existing =
          (ctx.scratchpad.get("redact_log") as Array<{
            scope: string;
            replacements: RedactReplacement[];
            timestamp: string;
          }>) ?? [];
        ctx.scratchpad.set("redact_log", [
          ...existing,
          {
            scope: "stream_delta",
            replacements: _streamRedactions,
            timestamp: new Date().toISOString(),
          },
        ]);
      } catch (logErr) {
        req.log.warn({ err: logErr }, "stream redaction-log persist failed");
      }
    }

    // Persist session state. The `session` event already fired at stream
    // open. `persistTurnState` dumps the scratchpad (sans budget), redacts
    // and truncates `awaitingQuestion` (so SMILES / NCE-IDs / compound codes
    // never leak into the agent_sessions row or the SSE event), and writes
    // via saveSession with optimistic concurrency. The same helper is used
    // by the chained-execution loop in routes/sessions.ts so both paths
    // honour the same redaction contract.
    if (sessionId) {
      try {
        const { awaitingQuestion: safeAwaitingQuestion } = await persistTurnState(
          deps.pool,
          user,
          sessionId,
          ctx,
          budget,
          finishReason,
          {
            expectedEtag: sessionEtag,
            messageCount: messages.length,
            priorSessionSteps: sessionStepsUsed,
          },
        );

        // If the model called ask_user, emit the awaiting_user_input event
        // before the final `finish` so clients render the prompt UI.
        if (safeAwaitingQuestion && !closed) {
          try {
            writeEvent(reply, {
              type: "awaiting_user_input",
              session_id: sessionId,
              question: safeAwaitingQuestion,
            });
          } catch {
            // socket already gone
          }
        }
      } catch (saveErr) {
        req.log.warn({ err: saveErr }, "saveSession failed");
      }
    }

    // Phase 4B: session_end fires only on a clean stop. Awaiting-input,
    // budget-exceeded, and concurrent-modification leave the session open
    // for the next turn — those are not terminations.
    if (sessionId && finishReason === "stop") {
      try {
        await lifecycle.dispatch("session_end", {
          ctx,
          sessionId,
          finishReason,
        });
      } catch (err) {
        req.log.warn({ err }, "session_end dispatch failed (non-fatal)");
      }
    }

    if (!closed) {
      try {
        writeEvent(reply, {
          type: "finish",
          finishReason,
          usage: budget?.summary() ?? { promptTokens: 0, completionTokens: 0 },
        });
      } catch {
        // socket already gone
      }
    }

    // Record final LLM usage on the root span and close it.
    try {
      const usageSummary = budget?.summary() ?? { promptTokens: 0, completionTokens: 0 };
      recordLlmUsage(rootSpan, {
        promptTokens: usageSummary.promptTokens,
        completionTokens: usageSummary.completionTokens,
        model: deps.config.AGENT_MODEL,
      });
    } catch (spanErr) {
      try { recordSpanError(rootSpan, spanErr); } catch { /* ignore */ }
    }
    try { rootSpan.end(); } catch { /* ignore */ }

    if (paperclipHandle) {
      try {
        const usageSummary = budget?.summary() ?? { promptTokens: 0, completionTokens: 0 };
        const totalTokens = usageSummary.promptTokens + usageSummary.completionTokens;
        const actualUsd = totalTokens * USD_PER_TOKEN_ESTIMATE;
        await paperclipHandle.release(totalTokens, actualUsd);
      } catch (relErr) {
        req.log.warn({ err: relErr }, "paperclip /release failed (non-fatal)");
      }
    }

    if (deps.shadowEvaluator && finishReason === "stop") {
      void deps.shadowEvaluator
        .evaluateAsync({
          promptName: "agent.system",
          messages,
          traceId: body.agent_trace_id ?? null,
          userEntraId: user,
        })
        .catch((shadowErr: unknown) => {
          req.log.debug({ err: shadowErr }, "shadow eval failed (non-fatal)");
        });
    }

    cleanupSkillForTurn?.();
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
    // Wrap the entire handler in an AsyncLocalStorage context so every
    // outbound MCP call can read the calling user's identity transparently
    // (see core/request-context.ts and mcp/postJson.ts:authHeaders).
    (req, reply) =>
      runWithRequestContext({ userEntraId: deps.getUser(req) }, () =>
        handleChat(req, reply, deps),
      ),
  );
}
