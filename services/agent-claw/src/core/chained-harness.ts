// Shared helper: run the harness one or more times against a session,
// auto-chaining until completion / max_steps cap / session-budget trip.
//
// Extracted from routes/sessions.ts as part of the PR-6 god-file split.
// Used by:
//   - POST /api/sessions/:id/plan/run        (chained plan execution)
//   - POST /api/sessions/:id/resume          (synthetic-continue, public)
//   - POST /api/internal/sessions/:id/resume (synthetic-continue, JWT-auth)
//   - tests/integration/chained-execution.test.ts (direct invocation)
//
// The function wraps an inner loop in `runWithRequestContext` so every
// outbound MCP postJson / getJson fired across the chain shares the same
// userEntraId, sessionId, and AbortSignal.

import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  loadSession,
  OptimisticLockError,
} from "./session-store.js";
import {
  Budget,
  BudgetExceededError,
  SessionBudgetExceededError,
} from "./budget.js";
import { runHarness } from "./harness.js";
import { AwaitingUserInputError } from "../tools/builtins/ask_user.js";
import { hydrateScratchpad, persistTurnState } from "./session-state.js";
import { lifecycle } from "./runtime.js";
import { runWithRequestContext } from "./request-context.js";
import { hashUser } from "../observability/user-hash.js";
import {
  PaperclipClient,
  PaperclipBudgetError,
  USD_PER_TOKEN_ESTIMATE,
  type ReservationHandle,
} from "./paperclip-client.js";
import type { Message, ToolContext } from "./types.js";

export interface ChainedHarnessOptions {
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
  /** Optional upstream AbortSignal threaded through to runHarness on every
   * chained iteration. The plan/run + resume routes pass `req.signal`
   * so a client disconnect (or a signal-bearing internal caller) cancels
   * both the LLM call and any in-flight MCP postJson / getJson fetches.
   * Background callers (the reanimator daemon) leave this undefined. */
  signal?: AbortSignal;
  /** Per-request correlation id. Plan/run + resume routes pass `req.id`;
   * the reanimator daemon synthesizes its own UUID per resume so that
   * background work still correlates across MCP services + projector
   * logs even though there's no incoming HTTP request. */
  requestId?: string;
}

export interface ChainedHarnessResult {
  autoTurns: number;
  totalSteps: number;
  finalFinishReason: string;
  /** Phase F4 — final current_step_index when planForProgress was supplied. */
  planFinalStepIndex?: number;
}

export async function runChainedHarness(
  opts: ChainedHarnessOptions,
): Promise<ChainedHarnessResult> {
  // Establish the AsyncLocalStorage context so every outbound MCP call
  // tags itself with the right user's identity AND the upstream signal —
  // the chained loop spans many runHarness calls, and we want every
  // postJson / getJson fired across all of them to share the same
  // cancellation semantics.
  return await runWithRequestContext(
    {
      userEntraId: opts.user,
      sessionId: opts.sessionId,
      signal: opts.signal,
      requestId: opts.requestId,
      userHash: hashUser(opts.user),
    },
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

    // The whole iteration body (hydrate → session_start → Budget → runHarness
     // → persistTurnState) lives inside this try so that the catch + finally
     // below can release a held Paperclip reservation on every exit path —
     // including the previously-unprotected window where hydrateScratchpad,
     // session_start dispatch, or `new Budget(...)` could throw between the
     // reserve and the harness call. Without this, an exception there
     // silently leaked the reservation for its TTL window and starved the
     // daily-USD cap (H-4 in the post-merge review).
    try {
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

      const r = await runHarness({
        messages: currentMessages,
        tools,
        llm,
        budget,
        lifecycle,
        ctx,
        signal: opts.signal,
        permissions: { permissionMode: "enforce" },
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

      // Persist updated session state via the shared persistTurnState
      // helper. Routes through the same redact-then-truncate path as
      // routes/chat.ts so a mid-chain ask_user with a SMILES / NCE-ID /
      // compound code in the question doesn't leak into the agent_sessions
      // row, the awaiting_user_input SSE event, or the reanimator's
      // downstream consumers. The previous inline dump bypassed redaction
      // — see C-3 in the post-merge review.
      await persistTurnState(
        pool,
        user,
        sessionId,
        ctx,
        budget,
        r.finishReason,
        {
          expectedEtag: state.etag,
          messageCount: currentMessages.length,
          priorSessionSteps: state.sessionSteps,
        },
      );

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
  // We reload the session row before dispatching so `endCtx.scratchpad`
  // reflects the persisted state at chain end (post the last
  // `persistTurnState`). Previously this synthesized an empty Map and
  // empty Set — third-party `session_end` hooks would silently see a
  // blank ctx and either no-op or write degenerate telemetry. The
  // reload is one extra DB roundtrip per chain (chains are rare; cost
  // is negligible). If the load fails we fall back to the empty-ctx
  // shape so a hook author who tolerates an empty Map keeps working.
  if (sessionStartFired && finalFinishReason === "stop") {
    try {
      let endScratchpad = new Map<string, unknown>();
      let endSeenFactIds = new Set<string>();
      try {
        const finalState = await loadSession(pool, user, sessionId);
        if (finalState) {
          const hydrated = hydrateScratchpad(
            finalState.scratchpad,
            sessionId,
            cfg.AGENT_TOKEN_BUDGET,
          );
          endScratchpad = hydrated.scratchpad;
          endSeenFactIds = hydrated.seenFactIds;
        }
      } catch (loadErr) {
        log.warn(
          { err: loadErr },
          "session_end: final loadSession failed; falling back to empty ctx",
        );
      }
      const endCtx: ToolContext = {
        userEntraId: user,
        seenFactIds: endSeenFactIds,
        scratchpad: endScratchpad,
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
