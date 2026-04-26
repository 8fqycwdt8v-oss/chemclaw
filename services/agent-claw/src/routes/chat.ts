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
// SSE event types: text_delta | tool_call | tool_result | plan_step | plan_ready | finish | error
//
// Defences:
//   - Dedicated lower rate limit (AGENT_CHAT_RATE_LIMIT_MAX).
//   - History cap (AGENT_CHAT_MAX_HISTORY) + per-message cap (AGENT_CHAT_MAX_INPUT_CHARS).
//   - Server-enforced maxSteps on the agent loop.
//   - Terminal-event guarantee: finish or error always emitted.
//   - Plan mode: LLM asked to produce JSON plan; plan_step + plan_ready events emitted; no tools execute.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import { Lifecycle } from "../core/lifecycle.js";
import { Budget, SessionBudgetExceededError } from "../core/budget.js";
import { buildAgent } from "../core/harness.js";
import {
  parseSlash,
  parseFeedbackArgs,
  shortCircuitResponse,
  HELP_TEXT,
} from "../core/slash.js";
import { redactString } from "../core/hooks/redact-secrets.js";
import type { RedactReplacement } from "../core/hooks/redact-secrets.js";
import { buildDefaultLifecycle } from "../core/harness-builders.js";
import {
  createSession,
  loadSession,
  saveSession,
  OptimisticLockError,
} from "../core/session-store.js";
import type { SessionFinishReason } from "../core/session-store.js";
import { savePlanForSession } from "../core/plan-store-db.js";
import { AwaitingUserInputError } from "../tools/builtins/ask_user.js";
import { withUserContext } from "../db/with-user-context.js";
import { PromptRegistry } from "../prompts/registry.js";
import type { Message, ToolContext } from "../core/types.js";
import type { PreToolPayload } from "../core/types.js";
import {
  planStore,
  createPlan,
  parsePlanSteps,
  PLAN_MODE_SYSTEM_SUFFIX,
  type PlanStep,
} from "../core/plan-mode.js";
import type { SkillLoader } from "../core/skills.js";
import { VERB_TO_SKILL } from "../core/skills.js";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; toolId: string; input: unknown }
  | { type: "tool_result"; toolId: string; output: unknown }
  | { type: "plan_step"; step_number: number; tool: string; args: unknown; rationale: string }
  | { type: "plan_ready"; plan_id: string; steps: PlanStep[]; created_at: number }
  // Emitted once per turn so clients can resume by passing session_id back.
  | { type: "session"; session_id: string }
  // Emitted by the manage_todos tool's post_tool hook.
  | { type: "todo_update"; todos: Array<{ id: string; ordering: number; content: string; status: string }> }
  // Emitted when the model called ask_user; the stream then ends with a
  // `finish` of finishReason="awaiting_user_input". Client must POST a
  // user message containing the answer with the same session_id to resume.
  | { type: "awaiting_user_input"; session_id: string; question: string }
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
  try {
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
      role: m.role as Message["role"],
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
  let priorScratchpad: Record<string, unknown> = {};
  // Phase F + H state captured at turn start.
  let sessionEtag: string | undefined;
  let sessionInputUsed = 0;
  let sessionOutputUsed = 0;
  let sessionStepsUsed = 0;
  let sessionInputCap = deps.config.AGENT_SESSION_INPUT_TOKEN_BUDGET;
  let sessionOutputCap = deps.config.AGENT_SESSION_OUTPUT_TOKEN_BUDGET;
  if (sessionId) {
    try {
      const loaded = await loadSession(deps.pool, user, sessionId);
      if (loaded) {
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

  // seenFactIds: rehydrate from prior scratchpad if present, else fresh.
  const _initialSeenFactIds = new Set<string>(
    Array.isArray(priorScratchpad["seenFactIds"])
      ? (priorScratchpad["seenFactIds"] as string[])
      : [],
  );
  const _scratchpad = new Map<string, unknown>();
  // Hydrate everything else from the prior scratchpad (except keys the
  // budget/seenFactIds setup below handles explicitly).
  for (const [k, v] of Object.entries(priorScratchpad)) {
    if (k === "seenFactIds" || k === "budget") continue;
    _scratchpad.set(k, v);
  }
  _scratchpad.set("budget", {
    promptTokensUsed: 0,
    completionTokensUsed: 0,
    tokenBudget: deps.config.AGENT_TOKEN_BUDGET,
  });
  _scratchpad.set("seenFactIds", _initialSeenFactIds);
  if (sessionId) _scratchpad.set("session_id", sessionId);
  const ctx: ToolContext = {
    userEntraId: user,
    seenFactIds: _initialSeenFactIds,
    scratchpad: _scratchpad,
  };

  const lifecycle = buildDefaultLifecycle();

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

  if (!doStream) {
    // Non-streaming path.
    try {
      if (isPlanMode) {
        // Plan mode: ask LLM to produce a JSON plan; no tool execution.
        const planJson = await deps.llm.completeJson({
          system: systemPrompt,
          user: lastUserMessage?.content ?? "",
        });
        const steps = parsePlanSteps(planJson);
        const plan = createPlan(steps, messages);
        planStore.save(plan);
        cleanupSkillForTurn?.();
        return void reply.send({
          plan_id: plan.plan_id,
          steps: plan.steps,
          created_at: plan.created_at,
        });
      }
      const result = await agent.run({ messages, ctx });
      cleanupSkillForTurn?.();
      return void reply.send({ text: result.text, finishReason: result.finishReason, usage: result.usage });
    } catch (err) {
      req.log.error({ err }, "chat generate failed");
      cleanupSkillForTurn?.();
      return void reply.code(500).send({ error: "internal" });
    }
  }

  // ------- SSE streaming path -------
  setupSse(reply);

  // Tell the client which session id to thread through subsequent POSTs.
  // Emitted before any tool/text event so a UI can immediately render
  // "session: <id>" or store it locally for resume.
  if (sessionId) {
    writeEvent(reply, { type: "session", session_id: sessionId });
  }

  let closed = false;
  const onClose = () => { closed = true; };
  req.raw.on("close", onClose);
  req.raw.on("aborted", onClose);

  // Hoisted out of the try block so the finally can read them when the loop
  // exits via error. Mirrors runHarness() in core/harness.ts.
  let finishReason = "stop";
  let finalText = "";
  let stepsUsed = 0;
  // Streaming redaction log: each text_delta is scrubbed in flight via
  // redactString; replacements are persisted to scratchpad before post_turn.
  const _streamRedactions: RedactReplacement[] = [];
  let budget: Budget | undefined;

  try {
    // Plan mode: ask LLM for a JSON plan; emit plan_step + plan_ready; no tool execution.
    if (isPlanMode) {
      try {
        const planJson = await deps.llm.completeJson({
          system: systemPrompt,
          user: lastUserMessage?.content ?? "",
        });
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
        const plan = createPlan(steps, messages);
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
      } catch (err) {
        req.log.error({ err }, "plan-mode failed");
        if (!closed) writeEvent(reply, { type: "error", error: "plan_mode_failed" });
      } finally {
        cleanupSkillForTurn?.();
        try { reply.raw.end(); } catch { /* already closed */ }
      }
      return;
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

        // Tool execution: AwaitingUserInputError is the documented control-flow
        // exception (ask_user) — caught here, NOT in the outer try, so post_turn
        // and session save still run normally and the awaiting_user_input event
        // is emitted from the finally block.
        let rawOutput: unknown;
        try {
          rawOutput = await tool.execute(ctx, parsedInput);
        } catch (toolErr) {
          if (toolErr instanceof AwaitingUserInputError) {
            finishReason = "awaiting_user_input";
            // Don't emit a tool_result for ask_user — the awaiting_user_input
            // event below replaces it. The model isn't going to read this
            // result anyway since the loop ends.
            break streaming;
          }
          throw toolErr;
        }
        const parsedOutput = tool.outputSchema.parse(rawOutput);

        const postPayload = { ctx, toolId, input: effectiveInput, output: parsedOutput };
        await lifecycle.dispatch("post_tool", postPayload);
        const effectiveOutput = postPayload.output;

        writeEvent(reply, { type: "tool_result", toolId, output: effectiveOutput });

        // todo_update event: emit the latest checklist whenever manage_todos
        // mutates state. The tool's output schema guarantees a `todos` array.
        if (
          toolId === "manage_todos" &&
          effectiveOutput &&
          typeof effectiveOutput === "object" &&
          "todos" in effectiveOutput &&
          Array.isArray((effectiveOutput as { todos: unknown }).todos)
        ) {
          writeEvent(reply, {
            type: "todo_update",
            todos: (effectiveOutput as {
              todos: Array<{ id: string; ordering: number; content: string; status: string }>;
            }).todos,
          });
        }

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

      if (!closed) {
        try {
          let streamed = "";
          for await (const chunk of deps.llm.streamCompletion(messages, tools)) {
            if (closed) break;
            if (chunk.type === "text_delta") {
              const redacted = redactString(chunk.delta, _streamRedactions);
              streamed += redacted;
              writeEvent(reply, { type: "text_delta", delta: redacted });
            }
            // finish/tool_call chunks from the stream are not re-emitted here;
            // the harness emits its own finish event below.
          }
          // If the stream yielded text, use it as the canonical final text.
          if (streamed) {
            finalText = streamed;
          }
        } catch {
          // Stream failed — fall back to the complete text we got from call().
          const redactedFallback = redactString(finalText, _streamRedactions);
          finalText = redactedFallback;
          writeEvent(reply, { type: "text_delta", delta: redactedFallback });
        }
      }

      messages.push({ role: "assistant", content: finalText });
      break streaming;
    }
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
    } else if (err instanceof OptimisticLockError) {
      req.log.warn({ err }, "chat stream stopped: concurrent modification");
      finishReason = "concurrent_modification";
      if (!closed) {
        writeEvent(reply, { type: "error", error: "concurrent_modification" });
      }
    } else if (err instanceof AwaitingUserInputError) {
      // ask_user fired during the streaming loop AFTER our inner break
      // streaming caught and consumed it. Reaching this branch means
      // the harness loop re-threw it; treat as a normal awaiting-input
      // exit, NOT an error.
      finishReason = "awaiting_user_input";
    } else {
      req.log.error({ err }, "chat stream failed");
      if (!closed) {
        writeEvent(reply, { type: "error", error: "internal" });
      }
    }
  } finally {
    // post_turn fires even if the streaming loop threw — mirrors runHarness().
    // The redact-secrets hook scrubs finalText here; for streaming responses
    // each delta was already scrubbed via redactString above, so this is a
    // belt-and-suspenders pass that also writes the audit log to scratchpad.
    try {
      // Persist any in-flight stream redactions to scratchpad before post_turn
      // runs so observability captures both layers.
      if (_streamRedactions.length > 0) {
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
      }
      await lifecycle.dispatch("post_turn", { ctx, finalText, stepsUsed });
    } catch (postTurnErr) {
      req.log.warn({ err: postTurnErr }, "post_turn dispatch failed");
    }

    // Persist session state. Emits a `session` event already happened at
    // stream open. We dump the current scratchpad (sans budget — recomputed
    // each turn) and the finish reason so the next turn (or the resume
    // endpoint) can pick up cleanly. seenFactIds is serialized as an array.
    if (sessionId) {
      try {
        const dump: Record<string, unknown> = {};
        for (const [k, v] of ctx.scratchpad.entries()) {
          if (k === "budget") continue; // recomputed every turn
          dump[k] = v instanceof Set ? Array.from(v) : v;
        }
        // The awaitingQuestion field is set by the ask_user tool; if present
        // in scratchpad we lift it to the dedicated column for the
        // awaiting_user_input SSE event below.
        const awaitingQuestion =
          typeof dump["awaitingQuestion"] === "string"
            ? (dump["awaitingQuestion"] as string)
            : null;
        // Redact the awaitingQuestion BEFORE persistence + SSE emit. The
        // model may have phrased its clarification in terms of a SMILES /
        // NCE-ID / compound code — those leak into both the SSE event
        // payload and the agent_sessions row otherwise. Replacements are
        // appended to redact_log under scope="awaiting_question".
        let safeAwaitingQuestion = awaitingQuestion;
        if (awaitingQuestion) {
          const replacements: RedactReplacement[] = [];
          safeAwaitingQuestion = redactString(awaitingQuestion, replacements);
          if (replacements.length > 0) {
            const existing =
              (ctx.scratchpad.get("redact_log") as Array<{
                scope: string;
                replacements: RedactReplacement[];
                timestamp: string;
              }>) ?? [];
            ctx.scratchpad.set("redact_log", [
              ...existing,
              {
                scope: "awaiting_question",
                replacements,
                timestamp: new Date().toISOString(),
              },
            ]);
            // Re-dump scratchpad so the redact_log update is persisted.
            dump["redact_log"] = ctx.scratchpad.get("redact_log");
          }
        }

        // Persist updated session totals so the next turn picks up where
        // this one left off.
        const sessTotals = budget?.sessionTotals();
        await saveSession(deps.pool, user, sessionId, {
          scratchpad: dump,
          lastFinishReason: (finishReason as SessionFinishReason) ?? null,
          awaitingQuestion: safeAwaitingQuestion,
          messageCount: messages.length,
          sessionInputTokens: sessTotals?.inputTokens,
          sessionOutputTokens: sessTotals?.outputTokens,
          sessionSteps: sessionStepsUsed + (budget?.stepsUsed ?? 0),
          // Optimistic concurrency. If a parallel turn raced us,
          // OptimisticLockError fires here; we log and accept (the parallel
          // writer's state is what survives). We do NOT clobber.
          expectedEtag: sessionEtag,
        });

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
    (req, reply) => handleChat(req, reply, deps),
  );
}
