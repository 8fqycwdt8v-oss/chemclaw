// Pre-harness setup for the chat route — resolves the session, hydrates
// the scratchpad, and builds the system prompt.
//
// Extracted from routes/chat.ts as part of the PR-6 god-file split. Each
// helper has a single responsibility and is independently callable from
// tests:
//
//   buildSystemPromptForTurn — load agent.system from prompt_registry,
//                              prepend active-skill prompts, append
//                              plan-mode suffix.
//   resolveSession           — load existing session OR create fresh one;
//                              returns the bag of session-scoped state
//                              the rest of the handler needs.

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { PromptRegistry } from "../prompts/registry.js";
import type { SkillLoader } from "../core/skills.js";
import {
  createSession,
  loadSession,
  saveSession,
} from "../core/session-store.js";
import { PLAN_MODE_SYSTEM_SUFFIX } from "../core/plan-mode.js";

// ---------------------------------------------------------------------------
// System prompt assembly
// ---------------------------------------------------------------------------

export interface BuiltSystemPrompt {
  systemPrompt: string;
  activePromptVersion: number | undefined;
}

/**
 * Build the system prompt for one turn:
 *   1. agent.system from prompt_registry (with a minimal fallback if absent).
 *   2. Prepend any active-skill prompts via SkillLoader.buildSystemPrompt.
 *   3. Append PLAN_MODE_SYSTEM_SUFFIX when this is a plan-mode turn.
 */
export async function buildSystemPromptForTurn(
  promptRegistry: PromptRegistry,
  loader: SkillLoader | undefined,
  isPlanMode: boolean,
  log: FastifyBaseLogger,
): Promise<BuiltSystemPrompt> {
  let systemPrompt = "";
  let activePromptVersion: number | undefined;
  try {
    try {
      const active = await promptRegistry.getActive("agent.system");
      systemPrompt = active.template;
      activePromptVersion = active.version;
    } catch {
      log.warn("agent.system prompt not found in prompt_registry; using minimal fallback");
      systemPrompt = "You are ChemClaw, an autonomous chemistry knowledge agent.";
    }
  } catch (err) {
    log.error({ err }, "failed to load system prompt");
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

  return { systemPrompt, activePromptVersion };
}

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

export interface ResolvedSession {
  /** The session id we'll use for this turn. May be null if createSession
   *  failed — the handler can still serve the turn statelessly. */
  sessionId: string | null;
  /** Did the session row exist at the start of this turn? Drives the
   *  session_start dispatch's source ∈ {"create", "resume"}. */
  sessionExisted: boolean;
  /** Scratchpad from the prior turn — empty {} for a fresh session. */
  priorScratchpad: Record<string, unknown>;
  /** Most recent etag for optimistic concurrency on save. */
  sessionEtag: string | undefined;
  sessionInputUsed: number;
  sessionOutputUsed: number;
  sessionStepsUsed: number;
  /** Per-session input cap. Defaults to AGENT_SESSION_INPUT_TOKEN_BUDGET
   *  unless the session row carried an override. */
  sessionInputCap: number;
}

/**
 * Resolve the session for this turn.
 *
 * If `requestedSessionId` was supplied:
 *   - Try to load it. If found, capture all the session-scoped state and
 *     clear awaiting_question (the new user message answers it).
 *   - If load returns null (unknown / wrong tenant / expired), fall through
 *     to creating a fresh session.
 *   - If load throws (DB / RLS error), log loudly and fall through too.
 *
 * Then if there's no session id, attempt createSession; if THAT fails,
 * log and return null sessionId. The handler can still serve a stateless
 * turn — every downstream branch tolerates a null sessionId.
 */
export async function resolveSession(
  pool: Pool,
  user: string,
  cfg: Config,
  requestedSessionId: string | undefined,
  log: FastifyBaseLogger,
): Promise<ResolvedSession> {
  let sessionId: string | null = requestedSessionId ?? null;
  let sessionExisted = false;
  let priorScratchpad: Record<string, unknown> = {};
  let sessionEtag: string | undefined;
  let sessionInputUsed = 0;
  let sessionOutputUsed = 0;
  let sessionStepsUsed = 0;
  let sessionInputCap = cfg.AGENT_SESSION_INPUT_TOKEN_BUDGET;

  if (sessionId) {
    try {
      const loaded = await loadSession(pool, user, sessionId);
      if (loaded) {
        sessionExisted = true;
        priorScratchpad = loaded.scratchpad;
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
        const saved = await saveSession(pool, user, sessionId, {
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
      log.error({ err, sessionId }, "loadSession threw — DB/RLS error; treating as fresh");
      sessionId = null;
    }
  }
  if (!sessionId) {
    try {
      sessionId = await createSession(pool, user);
    } catch (err) {
      // Non-fatal: if session creation fails the agent can still serve the
      // turn statelessly. Log and proceed.
      log.warn({ err }, "createSession failed; continuing without session");
    }
  }

  return {
    sessionId,
    sessionExisted,
    priorScratchpad,
    sessionEtag,
    sessionInputUsed,
    sessionOutputUsed,
    sessionStepsUsed,
    sessionInputCap,
  };
}
