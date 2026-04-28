// Session-state helpers shared by the chat / plan / sessions / deep-research
// routes. Extracted from the (now-deleted) core/harness-builders.ts so that
// `hydrateScratchpad` and `persistTurnState` live in a focused module
// independent of the lifecycle wiring (which is now sourced from
// core/runtime.ts).

import type { Pool } from "pg";
import type { ToolContext } from "./types.js";
import {
  saveSession,
  type SessionFinishReason,
} from "./session-store.js";
import type { Budget } from "./budget.js";

/**
 * Hydrate a fresh scratchpad Map from a stored session's scratchpad jsonb.
 *
 * Drops the keys we re-initialise (`budget` is recomputed per turn,
 * `seenFactIds` is rehydrated as a Set on the ToolContext directly) and
 * carries everything else forward. Also injects `session_id` so tools
 * (manage_todos, ask_user) can find it.
 */
export function hydrateScratchpad(
  prior: Record<string, unknown>,
  sessionId: string | null,
  tokenBudget: number,
): { scratchpad: Map<string, unknown>; seenFactIds: Set<string> } {
  const seenFactIds = new Set<string>(
    Array.isArray(prior["seenFactIds"]) ? (prior["seenFactIds"] as string[]) : [],
  );
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
  scratchpad.set("seenFactIds", seenFactIds);
  if (sessionId) scratchpad.set("session_id", sessionId);
  return { scratchpad, seenFactIds };
}

/**
 * Persist end-of-turn state back to the agent_sessions row.
 *
 * Centralises the dump-scratchpad + serialize-Sets + lift-awaitingQuestion
 * pattern that previously appeared in both routes/chat.ts (finally block)
 * and routes/sessions.ts (per-iteration in runChainedHarness). Returns the
 * lifted awaiting_question (or null) so the caller can emit the SSE event.
 */
export async function persistTurnState(
  pool: Pool,
  userEntraId: string,
  sessionId: string,
  ctx: ToolContext,
  budget: Budget | undefined,
  finishReason: string,
  opts: {
    expectedEtag?: string;
    messageCount?: number;
    priorSessionSteps?: number;
  } = {},
): Promise<{ awaitingQuestion: string | null }> {
  const dump: Record<string, unknown> = {};
  for (const [k, v] of ctx.scratchpad.entries()) {
    if (k === "budget") continue; // recomputed every turn
    dump[k] = v instanceof Set ? Array.from(v) : v;
  }
  const rawAwaitingQuestion =
    typeof dump["awaitingQuestion"] === "string"
      ? (dump["awaitingQuestion"] as string)
      : null;
  // Truncate to the 4000-codepoint CHECK constraint added in
  // db/init/16_db_audit_fixes.sql, codepoint-safely (Array.from prevents
  // a UTF-16 surrogate split that would otherwise produce invalid UTF-8
  // and crash the INSERT mid-finally). Mirrors the redact-then-truncate
  // pattern in routes/chat.ts:854 — kept here too so any future caller
  // that reaches saveSession through this helper is safe by default
  // without a copy-paste of the truncate math.
  const awaitingQuestion = _truncateAwaitingQuestion(rawAwaitingQuestion);

  const sessTotals = budget?.sessionTotals();
  await saveSession(pool, userEntraId, sessionId, {
    scratchpad: dump,
    lastFinishReason: (finishReason as SessionFinishReason) ?? null,
    awaitingQuestion,
    messageCount: opts.messageCount,
    sessionInputTokens: sessTotals?.inputTokens,
    sessionOutputTokens: sessTotals?.outputTokens,
    sessionSteps:
      opts.priorSessionSteps !== undefined
        ? opts.priorSessionSteps + (budget?.stepsUsed ?? 0)
        : undefined,
    expectedEtag: opts.expectedEtag,
  });

  return { awaitingQuestion };
}

const AWAITING_QUESTION_MAX_CODEPOINTS = 4000;
const AWAITING_QUESTION_TRUNCATED_SUFFIX = " [truncated…]";

function _truncateAwaitingQuestion(s: string | null): string | null {
  if (s === null) return null;
  const codepoints = Array.from(s);
  if (codepoints.length <= AWAITING_QUESTION_MAX_CODEPOINTS) return s;
  const suffixCps = Array.from(AWAITING_QUESTION_TRUNCATED_SUFFIX);
  return (
    codepoints
      .slice(0, AWAITING_QUESTION_MAX_CODEPOINTS - suffixCps.length)
      .join("") + AWAITING_QUESTION_TRUNCATED_SUFFIX
  );
}
