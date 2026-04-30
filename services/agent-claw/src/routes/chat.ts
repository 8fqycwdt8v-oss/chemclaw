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
import { Budget } from "../core/budget.js";
import { buildAgent, runHarness } from "../core/harness.js";
import { parseSlash } from "../core/slash.js";
import type { RedactReplacement } from "../core/hooks/redact-secrets.js";
import { hydrateScratchpad, persistTurnState } from "../core/session-state.js";
import { lifecycle } from "../core/runtime.js";
import { buildSystemPromptForTurn, resolveSession } from "./chat-setup.js";
import { runWithRequestContext } from "../core/request-context.js";
import type {
  Message,
  ToolContext,
} from "../core/types.js";
import { VERB_TO_SKILL } from "../core/skills.js";
import { writeEvent, setupSse } from "../streaming/sse.js";
import { makeSseSink } from "../streaming/sse-sink.js";
import { startRootTurnSpan, recordLlmUsage, recordSpanError } from "../observability/spans.js";
import { context as otelContext, trace } from "@opentelemetry/api";
import { USD_PER_TOKEN_ESTIMATE } from "../core/paperclip-client.js";
import {
  ChatRequestSchema,
  enforceBounds,
  type ChatRouteDeps,
} from "./chat-helpers.js";
import { handleSlashShortCircuit } from "./chat-slash.js";
import { dispatchManualCompact } from "./chat-compact.js";
import { reserveTurnBudget } from "./chat-paperclip.js";
import { handleNonStreamingTurn } from "./chat-non-streaming.js";
import { runPlanModeStreaming } from "./chat-plan-mode.js";
import { classifyStreamError } from "./chat-streaming-error.js";
import { maybeFireShadowEval } from "./chat-shadow-eval.js";
import { emitTerminalEvents } from "./chat-streaming-sse.js";

// Re-exported so existing imports `import type { StreamEvent } from "./chat.js"`
// keep compiling — the canonical home is now ../streaming/sse.ts.
export type { StreamEvent } from "../streaming/sse.js";
// Re-exported so the bootstrap layer's existing route-deps wiring keeps
// importing ChatRouteDeps from this module.
export type { ChatRouteDeps } from "./chat-helpers.js";

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

  // Short-circuit verbs that don't need the LLM (/help, /skills, /feedback,
  // /check, /learn, unknown). Returns true when handled — see chat-slash.ts.
  if (await handleSlashShortCircuit(req, reply, deps, body, user, slashResult, doStream)) {
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
  // See chat-setup.ts for the assembly contract.
  const { systemPrompt, activePromptVersion } = await buildSystemPromptForTurn(
    deps.promptRegistry,
    loader,
    isPlanMode,
    req.log,
  );

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    ...body.messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolId: m.toolId,
    })),
  ];

  // ── Session: load existing or create fresh. ───────────────────────────────
  // See chat-setup.ts/resolveSession for the load-or-create contract.
  // If the client supplied session_id, the prior scratchpad / etag /
  // budget totals are captured and awaiting_question is cleared (the
  // new user message IS the answer). If not, a fresh session id is
  // minted — the SSE path emits a `session` event so the client can
  // resume on the next turn.
  const sessionResolution = await resolveSession(
    deps.pool,
    user,
    deps.config,
    body.session_id,
    req.log,
  );
  const sessionId = sessionResolution.sessionId;
  // Phase 4B: track whether the session existed at the start of this turn
  // so the session_start dispatch can pass source ∈ {"create", "resume"}.
  const sessionExisted = sessionResolution.sessionExisted;
  const priorScratchpad = sessionResolution.priorScratchpad;
  // Phase F + H state captured at turn start.
  const sessionEtag = sessionResolution.sessionEtag;
  const sessionInputUsed = sessionResolution.sessionInputUsed;
  const sessionOutputUsed = sessionResolution.sessionOutputUsed;
  const sessionStepsUsed = sessionResolution.sessionStepsUsed;
  const sessionInputCap = sessionResolution.sessionInputCap;
  const sessionOutputCap = deps.config.AGENT_SESSION_OUTPUT_TOKEN_BUDGET;

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
  // Fires pre_compact + post_compact with trigger="manual" so the
  // compact-window hook mutates `messages` in place before the harness
  // runs against the compacted window. See routes/chat-compact.ts.
  if (slashResult.verb === "compact") {
    await dispatchManualCompact(
      lifecycle,
      ctx,
      messages,
      slashResult.args.trim() || null,
      req.log,
    );
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
  // non-streaming paths so daily-USD enforcement is uniform. A budget
  // refusal surfaces as HTTP 429 with Retry-After before any response
  // body opens. See routes/chat-paperclip.ts.
  const reservation = await reserveTurnBudget(
    deps.paperclip,
    reply,
    user,
    sessionId,
    req.log,
    () => cleanupSkillForTurn?.(),
  );
  if (!reservation.ok) {
    return; // 429 already sent by the helper
  }
  const paperclipHandle = reservation.handle;

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

  if (!doStream) {
    // Non-streaming path. Owns its own try/finally lifetime — no
    // post_turn dispatch, no session persistence — and shares the
    // rootSpan + paperclipHandle teardown with the streaming path's
    // finally via the closeTurn helper inside chat-non-streaming.ts.
    await handleNonStreamingTurn(req, reply, {
      isPlanMode,
      systemPrompt,
      lastUserContent: lastUserMessage?.content ?? "",
      messages,
      ctx,
      agent,
      llm: deps.llm,
      user,
      model: deps.config.AGENT_MODEL,
      rootSpan,
      paperclipHandle,
      cleanupSkillForTurn,
      signal: req.signal,
    });
    return;
  }

  // ------- SSE streaming path -------
  setupSse(reply);

  // NOTE: onSession fires BEFORE pre_turn (when both streamSink and
  // sessionId are set) — runHarness drives the `session` SSE event via the
  // sink. We do NOT emit it here directly — that would double-fire when
  // runHarness runs.

  // Boxed so the value can be mutated by the close-handler closure without
  // TS narrowing every subsequent read to the literal `false` initializer.
  const conn: { closed: boolean } = { closed: false };
  const onClose = () => { conn.closed = true; };
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
  // AbortSignal propagation: see runHarness({ signal }). The route forwards
  // `req.signal` (Fastify's underlying Node IncomingMessage signal,
  // Node 18+) into HarnessOptions so a client disconnect mid-stream cancels
  // the LLM call, in-flight MCP postJson / getJson calls, and the harness
  // loop. The harness throws an AbortError that the catch arm below maps
  // to finishReason="cancelled" and the finally block persists.
  const _streamRedactions: RedactReplacement[] = [];
  let budget: Budget | undefined;

  // Make rootSpan the active OTel context for the rest of the turn so
  // every LiteLLM auto-instrumented call inherits the parent and the
  // `prompt:agent.system` tag. The AsyncLocalStorageContextManager
  // registered in observability/otel.ts propagates this across awaits.
  const turnCtx = trace.setSpan(otelContext.active(), rootSpan);
  try {
    // Plan mode: ask LLM for a JSON plan; emit plan_step + plan_ready; no
    // tool execution. See routes/chat-plan-mode.ts for the SSE flow.
    if (isPlanMode) {
      const planFinish = await runPlanModeStreaming(req, reply, {
        llm: deps.llm,
        pool: deps.pool,
        systemPrompt,
        lastUserContent: lastUserMessage?.content ?? "",
        messages,
        user,
        sessionId,
        conn,
        turnCtx,
        signal: req.signal,
        cleanupSkillForTurn,
      });
      if (planFinish) finishReason = planFinish;
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
      // Forward the upstream client's AbortSignal so a mid-stream disconnect
      // (network drop, browser tab closed, curl --max-time) cancels LLM
      // calls + MCP fetches instead of running them to completion.
      signal: req.signal,
    });

    // v1.2 collapse: the hand-rolled call()→streamCompletion()→pre_tool /
    // post_tool / todo_update wiring that previously lived here was deleted
    // when runHarness became the single source of truth for the loop. All
    // those dispatches happen inside runHarness now, and the SSE adapter
    // (makeSseSink) translates StreamSink callbacks into the same wire
    // events. Keep the route handler short — see ADR 008.
    finishReason = result.finishReason;
  } catch (err) {
    // Six classified shapes (typed control-flow + quota errors + abort
    // detection + generic). See routes/chat-streaming-error.ts for the
    // full classification contract; the helper emits the typed `error`
    // event and returns the finishReason for our outer-scope `let`.
    const classified = classifyStreamError(err, conn, reply, req);
    finishReason = classified.finishReason;
  } finally {
    // Persist in-flight stream redactions to scratchpad for observability.
    // post_turn already ran inside runHarness; we append the stream_delta
    // log entry AFTER the post_turn redact-secrets entry. The two are
    // independent — redact-secrets reads/writes its own entry from finalText,
    // we append ours from the per-delta scrubs the SSE sink performed.
    if (_streamRedactions.length > 0) {
      try {
        const existing =
          (ctx.scratchpad.get("redact_log") as
            | Array<{
                scope: string;
                replacements: RedactReplacement[];
                timestamp: string;
              }>
            | undefined) ?? [];
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
        if (safeAwaitingQuestion && !conn.closed) {
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

    // Emit the inseparable cancelled-then-finish terminal pair. See
    // routes/chat-streaming-sse.ts for the ordering contract.
    emitTerminalEvents({
      reply,
      conn,
      finishReason,
      budget,
      sessionId,
    });

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

    maybeFireShadowEval({
      shadowEvaluator: deps.shadowEvaluator,
      finishReason,
      messages,
      traceId: body.agent_trace_id ?? null,
      userEntraId: user,
      log: req.log,
    });

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
    // (see core/request-context.ts and mcp/postJson.ts:authHeaders). Also
    // thread the upstream client's AbortSignal so postJson / getJson abort
    // their fetches when the client disconnects mid-stream.
    (req, reply) =>
      runWithRequestContext(
        { userEntraId: deps.getUser(req), signal: req.signal },
        () => handleChat(req, reply, deps),
      ),
  );
}
