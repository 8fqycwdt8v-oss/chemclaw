// Token + step caps with Paperclip integration point (Phase D).
// Phase A.1: in-memory only — no external budget service.

export interface BudgetOptions {
  /** Maximum number of LLM steps (tool calls count as steps). */
  maxSteps: number;
  /** Maximum total prompt tokens across all steps. */
  maxPromptTokens?: number;
  /** Maximum total completion tokens across all steps. */
  maxCompletionTokens?: number;
}

export class Budget {
  readonly maxSteps: number;
  readonly maxPromptTokens: number;
  readonly maxCompletionTokens: number;

  private _stepsUsed = 0;
  private _promptTokens = 0;
  private _completionTokens = 0;

  constructor(opts: BudgetOptions) {
    if (opts.maxSteps <= 0) {
      throw new RangeError(`maxSteps must be > 0, got ${opts.maxSteps}`);
    }
    this.maxSteps = opts.maxSteps;
    // Default token caps are intentionally generous; Paperclip-lite enforces
    // the tighter real-world limits in Phase D.
    this.maxPromptTokens = opts.maxPromptTokens ?? 200_000;
    this.maxCompletionTokens = opts.maxCompletionTokens ?? 32_000;
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
