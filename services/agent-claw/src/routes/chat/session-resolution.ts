// Session + system-prompt resolution for /api/chat.
//
// Runs after slash parsing and before harness invocation. Builds the
// system prompt (registry + active skills + plan-mode suffix), threads
// the message array, loads or mints the session row, and dispatches the
// pre-harness lifecycle hooks (user_prompt_submit, session_start,
// optional manual /compact pre/post_compact pair).
//
// Reuses hydrateScratchpad from core/session-state.ts and the session
// store helpers from core/session-store.ts — no re-implementations.

import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Config } from "../../config.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import type { SkillLoader } from "../../core/skills.js";
import { VERB_TO_SKILL } from "../../core/skills.js";
import { lifecycle } from "../../core/runtime.js";
import { estimateTokenCount } from "../../core/budget.js";
import { hydrateScratchpad } from "../../core/session-state.js";
import {
  createSession,
  loadSession,
  saveSession,
} from "../../core/session-store.js";
import { PLAN_MODE_SYSTEM_SUFFIX } from "../../core/plan-mode.js";
import type { SlashParseResult } from "../../core/slash.js";
import type {
  Message,
  PostCompactPayload,
  PreCompactPayload,
  ToolContext,
} from "../../core/types.js";

/**
 * State assembled by `resolveTurnState` and consumed by both the streaming
 * and non-streaming harness paths. All fields downstream of `ctx` are the
 * point-in-time read from the session row at turn start; downstream code
 * passes `sessionEtag` to persistTurnState for optimistic concurrency.
 */
export interface TurnState {
  ctx: ToolContext;
  messages: Message[];
  sessionId: string | null;
  sessionExisted: boolean;
  sessionEtag: string | undefined;
  sessionInputUsed: number;
  sessionOutputUsed: number;
  sessionStepsUsed: number;
  sessionInputCap: number;
  sessionOutputCap: number;
  systemPrompt: string;
  activePromptVersion: number | undefined;
  cleanupSkillForTurn: (() => void) | undefined;
  isPlanMode: boolean;
  /** The trailing user-message text — needed by plan-mode and lifecycle dispatch. */
  lastUserContent: string;
}

export interface SessionResolutionDeps {
  config: Config;
  pool: Pool;
  promptRegistry: PromptRegistry;
  skillLoader?: SkillLoader;
}

/**
 * Build the system prompt by composing prompt_registry + active skills +
 * plan-mode suffix. Falls back to a minimal hardcoded string if the
 * registry read fails — startup-time correctness is the loud-fail path,
 * runtime degradation should not 500.
 */
async function buildSystemPrompt(
  req: FastifyRequest,
  deps: SessionResolutionDeps,
  loader: SkillLoader | undefined,
  isPlanMode: boolean,
): Promise<{ systemPrompt: string; activePromptVersion: number | undefined }> {
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

  if (loader && loader.activeIds.size > 0) {
    systemPrompt = loader.buildSystemPrompt(systemPrompt);
  }

  if (isPlanMode) {
    systemPrompt = systemPrompt + PLAN_MODE_SYSTEM_SUFFIX;
  }

  return { systemPrompt, activePromptVersion };
}

/**
 * Resolve all pre-harness state for a turn: skill activation, system
 * prompt assembly, session load-or-create, scratchpad hydration, and the
 * three pre-harness lifecycle dispatches (user_prompt_submit,
 * session_start, optional /compact pre/post_compact).
 *
 * The returned `cleanupSkillForTurn` MUST be invoked by the caller before
 * the response closes (success or error path).
 */
export async function resolveTurnState(
  req: FastifyRequest,
  body: { messages: Message[]; session_id?: string },
  user: string,
  slashResult: SlashParseResult,
  deps: SessionResolutionDeps,
): Promise<TurnState> {
  const lastUserMessage = [...body.messages].reverse().find((m) => m.role === "user");
  const lastUserContent = lastUserMessage?.content ?? "";
  const isPlanMode = slashResult.verb === "plan";

  // ── Skill activation for this turn ──────────────────────────────────────
  // If the slash verb implies a skill (e.g. /dr → deep_research), activate it
  // for this turn only (non-persistent). Persistent enable/disable goes
  // through POST /api/skills/enable|disable.
  const loader = deps.skillLoader;
  let cleanupSkillForTurn: (() => void) | undefined;
  if (loader && slashResult.verb) {
    const impliedSkill = VERB_TO_SKILL[slashResult.verb];
    if (impliedSkill && loader.has(impliedSkill)) {
      cleanupSkillForTurn = loader.enableForTurn(impliedSkill);
    }
  }

  const { systemPrompt, activePromptVersion } = await buildSystemPrompt(
    req,
    deps,
    loader,
    isPlanMode,
  );

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    ...body.messages.map((m) => ({
      role: m.role as Message["role"],
      content: m.content,
      toolId: m.toolId,
    })),
  ];

  // ── Session: load existing or create fresh. ─────────────────────────────
  // If the client supplied session_id, load the prior scratchpad and clear
  // any awaiting_question (the new user message IS the answer). If not,
  // mint a new session — the SSE path emits a `session` event so the
  // client can resume on the next turn.
  let sessionId: string | null = body.session_id ?? null;
  let sessionExisted = false;
  let priorScratchpad: Record<string, unknown> = {};
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
      prompt: lastUserContent,
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
  // against the compacted window.
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

  return {
    ctx,
    messages,
    sessionId,
    sessionExisted,
    sessionEtag,
    sessionInputUsed,
    sessionOutputUsed,
    sessionStepsUsed,
    sessionInputCap,
    sessionOutputCap,
    systemPrompt,
    activePromptVersion,
    cleanupSkillForTurn,
    isPlanMode,
    lastUserContent,
  };
}
