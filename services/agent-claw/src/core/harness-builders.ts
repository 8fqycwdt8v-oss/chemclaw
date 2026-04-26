// Shared harness setup helpers — extracted from routes/chat.ts, routes/plan.ts,
// and routes/sessions.ts so all three callers register the SAME default hooks
// and hydrate scratchpad the SAME way. Drift between these three was a real
// bug-bait (a hook added to chat.ts but not plan.ts would silently miss the
// approve flow).

import { Lifecycle } from "./lifecycle.js";
import { registerRedactSecretsHook } from "./hooks/redact-secrets.js";
import { registerTagMaturityHook } from "./hooks/tag-maturity.js";
import { registerBudgetGuardHook } from "./hooks/budget-guard.js";
import type { Pool } from "pg";
import type { ToolContext } from "./types.js";
import {
  saveSession,
  type SessionFinishReason,
} from "./session-store.js";
import type { Budget } from "./budget.js";

/**
 * Default lifecycle for chat / plan-approve / chained-resume routes.
 * Adding a new globally-applied hook? Add it here so every harness path
 * picks it up. Sub-agents register their own subset in core/sub-agent.ts.
 */
export function buildDefaultLifecycle(): Lifecycle {
  const lc = new Lifecycle();
  registerRedactSecretsHook(lc);
  registerTagMaturityHook(lc);
  registerBudgetGuardHook(lc);
  return lc;
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
