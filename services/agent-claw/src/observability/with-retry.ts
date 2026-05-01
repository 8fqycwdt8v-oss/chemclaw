// ---------------------------------------------------------------------------
// Bounded retry wrapper with structured per-attempt logging.
//
// MCP `postJson` / `getJson` calls are the most common failure surface in
// the harness — a single transient blip (TCP RST, 502 from a chemistry
// service warming up, a dropped Bearer-token validator) used to surface as
// an opaque tool failure with no breadcrumb. `withRetry` wraps a unit of
// work with capped exponential-backoff retries and emits one structured
// log line per attempt, plus a summary on exhaustion.
//
// Defaults:
//   - 3 attempts total (1 initial + 2 retries)
//   - 100ms base, 2x multiplier, ±25% jitter
//   - Retries every Error by default; pass `shouldRetry` to skip
//     non-retryable errors (e.g. 4xx) so we don't burn budget on them.
// ---------------------------------------------------------------------------

import type { Logger } from "pino";

import { getLogger } from "./logger.js";

export interface RetryOptions {
  /** Total attempts including the first. Defaults to 3. */
  attempts?: number;
  /** Base backoff in ms before the first retry. Defaults to 100. */
  baseMs?: number;
  /** Backoff multiplier per attempt. Defaults to 2. */
  multiplier?: number;
  /** Max backoff in ms (cap). Defaults to 5_000. */
  maxMs?: number;
  /**
   * Predicate gating retry. Default retries on every Error. Implementations
   * for HTTP-shaped errors should look at `err.status` and skip 4xx.
   */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Caller name for log correlation. Defaults to "with-retry". */
  operation?: string;
  /** Optional logger to use; falls back to a child of the default. */
  logger?: Logger;
  /** AbortSignal — when aborted, no more retries are attempted. */
  signal?: AbortSignal;
}

const DEFAULTS: Required<Omit<RetryOptions, "logger" | "shouldRetry" | "signal">> = {
  attempts: 3,
  baseMs: 100,
  multiplier: 2,
  maxMs: 5_000,
  operation: "with-retry",
};

function backoffMs(opts: Required<Omit<RetryOptions, "logger" | "shouldRetry" | "signal">>, attempt: number): number {
  const exp = opts.baseMs * Math.pow(opts.multiplier, attempt - 1);
  const capped = Math.min(exp, opts.maxMs);
  // ±25% jitter — avoids thundering-herd retries from N tools failing at once.
  const jitter = capped * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === "AbortError" || e.code === "ABORT_ERR";
}

/**
 * Run `fn` with retries and emit one log record per attempt + outcome.
 * Returns the successful result or rethrows the final error.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = {
    attempts: options.attempts ?? DEFAULTS.attempts,
    baseMs: options.baseMs ?? DEFAULTS.baseMs,
    multiplier: options.multiplier ?? DEFAULTS.multiplier,
    maxMs: options.maxMs ?? DEFAULTS.maxMs,
    operation: options.operation ?? DEFAULTS.operation,
  };
  const log = options.logger ?? getLogger("agent-claw.with-retry");
  const shouldRetry = options.shouldRetry ?? (() => true);
  const signal = options.signal;

  let lastErr: unknown;

  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    }
    try {
      const result = await fn(attempt);
      if (attempt > 1) {
        log.info(
          { event: "retry_succeeded", operation: opts.operation, attempt },
          "operation succeeded after retry",
        );
      }
      return result;
    } catch (err) {
      lastErr = err;
      const isLast = attempt === opts.attempts;
      // AbortError and non-retryable errors short-circuit immediately.
      if (isAbortError(err) || !shouldRetry(err, attempt)) {
        log.warn(
          {
            event: "retry_skipped",
            operation: opts.operation,
            attempt,
            err_name: (err as Error).name,
            err_msg: (err as Error).message,
          },
          "operation failed; not retrying",
        );
        throw err;
      }
      if (isLast) {
        log.error(
          {
            event: "retry_exhausted",
            operation: opts.operation,
            attempts: opts.attempts,
            err_name: (err as Error).name,
            err_msg: (err as Error).message,
          },
          "operation failed after all retries",
        );
        throw err;
      }
      const sleep = backoffMs(opts, attempt);
      log.warn(
        {
          event: "retry_scheduled",
          operation: opts.operation,
          attempt,
          backoff_ms: sleep,
          err_name: (err as Error).name,
          err_msg: (err as Error).message,
        },
        "operation failed; retrying",
      );
      await new Promise<void>((resolve) => {
        // Re-check the signal at executor entry: an abort fired
        // between the catch handler and the executor running won't
        // re-deliver via addEventListener (events don't replay), so
        // without this check we'd burn the full backoff before the
        // top-of-loop check catches the abort. Verified by debug
        // pass: prevents up-to-maxMs (5s default) tail-latency on
        // cancellation.
        if (signal?.aborted) {
          resolve();
          return;
        }
        const t = setTimeout(resolve, sleep);
        // Honour abort during sleep so we don't burn time on a cancelled call.
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    }
  }

  // Unreachable — the loop either returns or throws — but TS wants a fallback.
  // ESLint's `only-throw-error` rule wants an Error; wrap a non-Error
  // `lastErr` so the rule is satisfied without losing context.
  if (lastErr instanceof Error) throw lastErr;
  throw new Error(`withRetry exhausted: ${describeUnknown(lastErr)}`);
}

/** Render any thrown value into a stable string for error message
 * inclusion. Handles the JSON.stringify edge cases (cyclic, BigInt) so
 * we never surface `[object Object]` to operators. */
function describeUnknown(value: unknown): string {
  if (value === undefined) return "no attempts ran";
  try {
    const stringified = JSON.stringify(value);
    return stringified.length > 0 ? stringified : "<empty>";
  } catch {
    return "<unserializable>";
  }
}
