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
 * Re-bind `ctx.seenFactIds` to whatever Set currently lives at
 * `ctx.scratchpad["seenFactIds"]`.
 *
 * The init-scratch hook (pre_turn) replaces the scratchpad's seenFactIds
 * with a fresh Set on every turn. Without this resync, the `ctx.seenFactIds`
 * field still references the OLD Set seeded by `hydrateScratchpad` (or by
 * the sub-agent spawner) — an orphan that no longer participates in the
 * authoritative working memory. Tools that mutate via the scratchpad
 * write to one Set; tools that read `ctx.seenFactIds` see the other.
 *
 * Call this after every manual `lifecycle.dispatch("pre_turn", ...)` that
 * happens outside `runHarness`. `runHarness` itself uses this same helper.
 *
 * Fallback: if init-scratch wasn't registered (e.g., tests that use an
 * empty Lifecycle), seed a fresh Set into the scratchpad and bind it. This
 * keeps the post-condition "ctx.seenFactIds is the canonical Set" true
 * regardless of hook configuration.
 */
export function syncSeenFactIdsFromScratch(ctx: ToolContext): void {
  const fromScratch = ctx.scratchpad.get("seenFactIds");
  if (fromScratch instanceof Set) {
    ctx.seenFactIds = fromScratch as Set<string>;
    return;
  }
  if (!ctx.seenFactIds) {
    const fresh = new Set<string>();
    ctx.scratchpad.set("seenFactIds", fresh);
    ctx.seenFactIds = fresh;
  }
}

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
  const awaitingQuestion =
    typeof dump["awaitingQuestion"] === "string"
      ? (dump["awaitingQuestion"] as string)
      : null;

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
