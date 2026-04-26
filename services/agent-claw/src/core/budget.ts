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
  /** Cross-turn budget — when set, every consumeStep also charges against
   * the session totals. Loaded from agent_sessions at turn start. */
  session?: SessionBudgetSnapshot;
}

export class Budget {
  readonly maxSteps: number;
  readonly maxPromptTokens: number;
  readonly maxCompletionTokens: number;

  private _stepsUsed = 0;
  private _promptTokens = 0;
  private _completionTokens = 0;
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
