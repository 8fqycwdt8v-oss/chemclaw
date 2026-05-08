// Token + step caps with Paperclip integration point (Phase D).
//
// Two-tier model:
//   - per-turn cap (maxSteps, maxPromptTokens, maxCompletionTokens) — bounded
//     per /api/chat POST, regenerated each turn.
//   - per-session cap (sessionInputBudget, sessionOutputBudget) — accumulates
//     across turns, persisted on agent_sessions. Trips
//     SessionBudgetExceededError to distinguish from a per-turn overrun.

export interface SessionBudgetSnapshot {
  /** Tokens used so far across the entire session, before this turn. */
  inputUsed: number;
  outputUsed: number;
  /** Per-session cap. NULL means "use AGENT_SESSION_TOKEN_BUDGET env default". */
  inputCap: number;
  outputCap: number;
}

export interface BudgetOptions {
  /** Maximum number of LLM steps in this turn. */
  maxSteps: number;
  /** Maximum total prompt tokens this turn. */
  maxPromptTokens?: number;
  /** Maximum total completion tokens this turn. */
  maxCompletionTokens?: number;
  /**
   * Fraction of maxPromptTokens at or above which shouldCompact() returns
   * true and the harness fires pre_compact / post_compact mid-turn.
   * Default 0.6 mirrors Claude Code's automatic-compaction trigger.
   */
  compactionThreshold?: number;
  /** Cross-turn budget — when set, every consumeStep also charges against
   * the session totals. Loaded from agent_sessions at turn start. */
  session?: SessionBudgetSnapshot;
}

export class Budget {
  readonly maxSteps: number;
  readonly maxPromptTokens: number;
  readonly maxCompletionTokens: number;
  readonly compactionThreshold: number;

  private _stepsUsed = 0;
  private _promptTokens = 0;
  private _completionTokens = 0;
  // Latest LLM call's reported prompt-token count, i.e. an estimate of the
  // current message-window size. Distinct from `_promptTokens` (which is
  // cumulative across all steps for cost accounting) so the compaction
  // trigger asks "is the active window getting too big?" rather than "have
  // we spent a lot of prompt tokens this turn?". Without this split, a
  // turn with many small steps would trip compaction on cumulative spend
  // long before the actual window exceeded the threshold.
  private _currentPromptTokens = 0;
  private readonly _session: SessionBudgetSnapshot | undefined;

  constructor(opts: BudgetOptions) {
    if (opts.maxSteps <= 0) {
      throw new RangeError(`maxSteps must be > 0, got ${opts.maxSteps}`);
    }
    this.maxSteps = opts.maxSteps;
    // Default token caps are intentionally generous; Paperclip-lite enforces
    // the tighter real-world limits in Phase D.
    this.maxPromptTokens = opts.maxPromptTokens ?? 200_000;
    this.maxCompletionTokens = opts.maxCompletionTokens ?? 32_000;
    this.compactionThreshold = opts.compactionThreshold ?? 0.6;
    this._session = opts.session;
  }

  get stepsUsed(): number {
    return this._stepsUsed;
  }

  get promptTokens(): number {
    return this._promptTokens;
  }

  get completionTokens(): number {
    return this._completionTokens;
  }

  /**
   * Latest call's reported prompt-token count — current window estimate.
   * Exposed so the harness can report pre_tokens / post_tokens in the
   * pre_compact / post_compact payloads in the same units the trigger
   * decision uses (current window, not cumulative spend).
   */
  get currentPromptTokens(): number {
    return this._currentPromptTokens;
  }

  /** Updated session totals after this turn. Used by chat.ts to persist. */
  sessionTotals(): { inputTokens: number; outputTokens: number } | null {
    if (!this._session) return null;
    return {
      inputTokens: this._session.inputUsed + this._promptTokens,
      outputTokens: this._session.outputUsed + this._completionTokens,
    };
  }

  /**
   * Record usage for one step. Throws BudgetExceededError if any cap is hit.
   * Call AFTER each LLM response is received so the caller can surface the
   * partial result before raising.
   */
  consumeStep(usage: { promptTokens: number; completionTokens: number }): void {
    this._stepsUsed += 1;
    this._promptTokens += usage.promptTokens;
    this._completionTokens += usage.completionTokens;
    // Track the latest call's prompt size for shouldCompact() — see field doc.
    this._currentPromptTokens = usage.promptTokens;

    if (this._promptTokens > this.maxPromptTokens) {
      throw new BudgetExceededError(
        `prompt token budget exceeded: ${this._promptTokens} > ${this.maxPromptTokens}`,
        "prompt_tokens",
      );
    }
    if (this._completionTokens > this.maxCompletionTokens) {
      throw new BudgetExceededError(
        `completion token budget exceeded: ${this._completionTokens} > ${this.maxCompletionTokens}`,
        "completion_tokens",
      );
    }

    // Cross-turn (session-level) cap.
    if (this._session) {
      const sessIn = this._session.inputUsed + this._promptTokens;
      const sessOut = this._session.outputUsed + this._completionTokens;
      if (sessIn > this._session.inputCap) {
        throw new SessionBudgetExceededError(
          `session input-token budget exceeded: ${sessIn} > ${this._session.inputCap}`,
          "input_tokens",
        );
      }
      if (sessOut > this._session.outputCap) {
        throw new SessionBudgetExceededError(
          `session output-token budget exceeded: ${sessOut} > ${this._session.outputCap}`,
          "output_tokens",
        );
      }
    }
  }

  /** Returns true if the step cap has been reached (before consuming). */
  isStepCapReached(): boolean {
    return this._stepsUsed >= this.maxSteps;
  }

  /**
   * Returns true when the latest LLM call's prompt size has reached the
   * compaction threshold (current-window estimate, NOT cumulative spend).
   * Used by runHarness after each step to decide whether to dispatch
   * pre_compact / post_compact. No-op when maxPromptTokens is not
   * configured (we never compact unconditionally).
   */
  shouldCompact(): boolean {
    if (!this.maxPromptTokens) return false;
    return (
      this._currentPromptTokens >= this.compactionThreshold * this.maxPromptTokens
    );
  }

  /**
   * After compaction shrinks the message list, the harness re-estimates
   * the new prompt-token count. We update the current-window field so
   * shouldCompact() reflects the post-compaction baseline; cumulative
   * spend is unchanged because compaction doesn't refund prior calls.
   */
  resetPromptTokens(newCount: number): void {
    this._currentPromptTokens = Math.max(0, newCount);
  }

  /** Summary for logging and HarnessResult.usage. */
  summary(): { promptTokens: number; completionTokens: number } {
    return {
      promptTokens: this._promptTokens,
      completionTokens: this._completionTokens,
    };
  }
}

// ---------------------------------------------------------------------------
// Typed error so callers can distinguish budget overruns from other errors.
// ---------------------------------------------------------------------------
export class BudgetExceededError extends Error {
  readonly dimension: "steps" | "prompt_tokens" | "completion_tokens";

  constructor(
    message: string,
    dimension: "steps" | "prompt_tokens" | "completion_tokens",
  ) {
    super(message);
    this.name = "BudgetExceededError";
    this.dimension = dimension;
  }
}

/**
 * Distinct from BudgetExceededError — distinguishes "this turn's cap"
 * (which can be retried with a fresh budget) from "this session's lifetime
 * cap" (which requires admin override or cap bump). Surfaced as HTTP 429
 * with `{ error: "session_budget_exceeded" }` from /api/chat.
 */
export class SessionBudgetExceededError extends Error {
  readonly dimension: "input_tokens" | "output_tokens";

  constructor(message: string, dimension: "input_tokens" | "output_tokens") {
    super(message);
    this.name = "SessionBudgetExceededError";
    this.dimension = dimension;
  }
}

// ---------------------------------------------------------------------------
// estimateTokenCount — heuristic 4-chars-per-token used by the harness's
// pre_compact / post_compact dispatch sites (runHarness loop + manual
// /compact slash branch in chat.ts) to compute pre_tokens / post_tokens
// for the payload.
//
// This is intentionally a heuristic, not a tiktoken-accurate count: the
// goal is "did compaction shrink the window meaningfully?" which a 4:1
// char-to-token ratio answers within ±20% for English/scientific text.
// If this ever needs accuracy, swap in the real tokenizer at the same
// callsite — the threshold lives on Budget so the heuristic only feeds
// payload telemetry, not the trigger decision (consumeStep tracks the
// real model-reported usage).
// ---------------------------------------------------------------------------

import type { Message } from "./types.js";

export function estimateTokenCount(messages: Message[]): number {
  return Math.ceil(
    messages.reduce((sum, m) => sum + m.content.length, 0) / 4,
  );
}
