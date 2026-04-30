import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withRetry } from "../../src/observability/with-retry.js";

// Tests use a tiny logger mock so we don't pollute real Pino output but can
// still assert the structured fields. The default-options behaviour is then
// covered separately by the integration tests once the harness wires it.
function makeMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(function (this: ReturnType<typeof makeMockLogger>) {
      return this;
    }),
    level: "info",
  };
}

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the value on first success", async () => {
    const log = makeMockLogger();
    const fn = vi.fn(async () => "ok");
    const promise = withRetry(fn, {
      logger: log as unknown as Logger,
      operation: "happy",
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("retries until success and emits structured logs", async () => {
    const log = makeMockLogger();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return "ok";
    });
    const promise = withRetry(fn, {
      logger: log as unknown as Logger,
      operation: "flaky",
      baseMs: 1,
      maxMs: 10,
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "retry_scheduled", operation: "flaky", attempt: 1 }),
      expect.any(String),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "retry_succeeded", operation: "flaky", attempt: 3 }),
      expect.any(String),
    );
  });

  it("throws after exhausting attempts and logs retry_exhausted", async () => {
    // Real timers — baseMs=1 keeps the retry sleep negligible, and avoids
    // racing vitest's unhandled-rejection detector against fake-timer
    // advancement when the awaited promise is meant to reject.
    vi.useRealTimers();
    const log = makeMockLogger();
    const fn = vi.fn(async () => {
      throw new Error("never");
    });
    await expect(
      withRetry(fn, {
        logger: log as unknown as Logger,
        operation: "doomed",
        attempts: 2,
        baseMs: 1,
      }),
    ).rejects.toThrow("never");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "retry_exhausted", operation: "doomed", attempts: 2 }),
      expect.any(String),
    );
  });

  it("skips retry when shouldRetry returns false", async () => {
    // Real timers — non-retryable cases don't sleep, and using fake timers
    // would race the unhandled-rejection detector against the awaited
    // expect().rejects.toThrow().
    vi.useRealTimers();
    const log = makeMockLogger();
    const fn = vi.fn(async () => {
      throw new Error("4xx");
    });
    await expect(
      withRetry(fn, {
        logger: log as unknown as Logger,
        operation: "non-retryable",
        shouldRetry: () => false,
        attempts: 5,
        baseMs: 1,
      }),
    ).rejects.toThrow("4xx");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "retry_skipped" }),
      expect.any(String),
    );
  });

  it("aborts immediately when signal is already aborted", async () => {
    vi.useRealTimers();
    const log = makeMockLogger();
    const ctrl = new AbortController();
    ctrl.abort(new Error("upstream cancelled"));
    const fn = vi.fn(async () => "ok");
    await expect(
      withRetry(fn, {
        logger: log as unknown as Logger,
        signal: ctrl.signal,
        attempts: 3,
        baseMs: 1,
      }),
    ).rejects.toThrow("upstream cancelled");
    expect(fn).not.toHaveBeenCalled();
  });
});
