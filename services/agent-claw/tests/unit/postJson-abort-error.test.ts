// Regression: postJson's per-call timeout AND upstream-signal propagation
// MUST surface as AbortError-shaped exceptions, otherwise withRetry's
// `isAbortError` (`.name === "AbortError" || .code === "ABORT_ERR"`)
// won't match and a deliberate user cancellation gets retried 3×.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { postJson } from "../../src/mcp/postJson.js";

describe("postJson abort error shape", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    // Long-hanging fetch that respects the abort signal: rejects with
    // signal.reason when aborted, never resolves otherwise.
    const fakeFetch: typeof globalThis.fetch = (_url, init) => {
      return new Promise((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        const rejectFromSignal = (s: AbortSignal | undefined): void => {
          const reason: unknown = s?.reason;
          if (reason instanceof Error) {
            reject(reason);
          } else {
            reject(new Error("aborted"));
          }
        };
        if (sig?.aborted) {
          rejectFromSignal(sig);
          return;
        }
        sig?.addEventListener(
          "abort",
          () => rejectFromSignal(sig),
          { once: true },
        );
      });
    };
    globalThis.fetch = vi.fn(fakeFetch);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("on per-call timeout, rejects with an Error whose name === AbortError", async () => {
    const schema = z.object({ ok: z.boolean() });
    const start = Date.now();
    let caught: unknown;
    try {
      // 50ms timeout, fetch never resolves → timeout aborts the call.
      await postJson("http://x", {}, schema, 50, "test-svc");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("AbortError");
    // Sanity: didn't take much longer than the timeout.
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("on upstream signal abort with a generic reason, propagates an AbortError-shaped error", async () => {
    const schema = z.object({ ok: z.boolean() });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(new Error("client disconnected")), 20);
    let caught: unknown;
    try {
      await postJson("http://x", {}, schema, 5_000, "test-svc", {
        signal: ctl.signal,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("AbortError");
  });

  it("on upstream signal abort with a real AbortError reason, preserves it", async () => {
    const schema = z.object({ ok: z.boolean() });
    const ctl = new AbortController();
    const reason =
      typeof DOMException !== "undefined"
        ? new DOMException("upstream cancelled", "AbortError")
        : Object.assign(new Error("upstream cancelled"), { name: "AbortError" });
    setTimeout(() => ctl.abort(reason), 20);
    let caught: unknown;
    try {
      await postJson("http://x", {}, schema, 5_000, "test-svc", {
        signal: ctl.signal,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("AbortError");
  });
});
