// review-v2 cycle-2: pin every branch of classifyStreamError so a future
// refactor (e.g., a class rename, an instanceof drop) can't silently
// re-introduce the "error → 'stop'" finishReason regression that
// PR #61 just fixed for the generic case.

import { describe, it, expect, vi } from "vitest";
import { classifyStreamError } from "../../src/routes/chat-streaming-error.js";
import {
  BudgetExceededError,
  SessionBudgetExceededError,
} from "../../src/core/budget.js";
import { OptimisticLockError } from "../../src/core/session-store.js";
import { AwaitingUserInputError } from "../../src/tools/builtins/ask_user.js";

function fakeReply() {
  return { raw: { writableEnded: false, write: vi.fn() } };
}
function fakeReq(opts: { signal?: { aborted: boolean } } = {}) {
  return {
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    signal: opts.signal ?? { aborted: false },
  };
}

describe("classifyStreamError — all six branches", () => {
  it("SessionBudgetExceededError → finishReason='session_budget_exceeded' + emit", () => {
    const reply = fakeReply();
    const req = fakeReq();
    const err = new SessionBudgetExceededError("session over");
    const r = classifyStreamError(err, { closed: false }, reply as never, req as never);
    expect(r.finishReason).toBe("session_budget_exceeded");
    expect(req.log.warn).toHaveBeenCalled();
    expect(reply.raw.write).toHaveBeenCalledTimes(1);
    const written = reply.raw.write.mock.calls[0]?.[0] as string;
    expect(written).toContain('"error":"session_budget_exceeded"');
  });

  it("BudgetExceededError → finishReason='budget_exceeded' + emit", () => {
    const reply = fakeReply();
    const req = fakeReq();
    const err = new BudgetExceededError("budget exceeded");
    const r = classifyStreamError(err, { closed: false }, reply as never, req as never);
    expect(r.finishReason).toBe("budget_exceeded");
    expect(req.log.warn).toHaveBeenCalled();
    expect(reply.raw.write).toHaveBeenCalledTimes(1);
    expect(reply.raw.write.mock.calls[0]?.[0]).toContain('"error":"budget_exceeded"');
  });

  it("OptimisticLockError → finishReason='concurrent_modification' + emit", () => {
    const reply = fakeReply();
    const req = fakeReq();
    const err = new OptimisticLockError("etag mismatch");
    const r = classifyStreamError(err, { closed: false }, reply as never, req as never);
    expect(r.finishReason).toBe("concurrent_modification");
    expect(req.log.warn).toHaveBeenCalled();
    expect(reply.raw.write).toHaveBeenCalledTimes(1);
    expect(reply.raw.write.mock.calls[0]?.[0]).toContain('"error":"concurrent_modification"');
  });

  it("AwaitingUserInputError → finishReason='awaiting_user_input', NO emit", () => {
    const reply = fakeReply();
    const req = fakeReq();
    const err = new AwaitingUserInputError("ask user", "session-x");
    const r = classifyStreamError(err, { closed: false }, reply as never, req as never);
    expect(r.finishReason).toBe("awaiting_user_input");
    // No SSE error event — the outer finally lifts the question and emits awaiting_user_input.
    expect(reply.raw.write).not.toHaveBeenCalled();
  });

  it("AbortError → finishReason='cancelled', NO emit, info-level log", () => {
    const reply = fakeReply();
    const req = fakeReq();
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    const r = classifyStreamError(err, { closed: false }, reply as never, req as never);
    expect(r.finishReason).toBe("cancelled");
    expect(req.log.info).toHaveBeenCalled();
    expect(reply.raw.write).not.toHaveBeenCalled();
  });

  it("req.signal.aborted=true → finishReason='cancelled' even on non-AbortError", () => {
    const reply = fakeReply();
    const req = fakeReq({ signal: { aborted: true } });
    const err = new Error("some unrelated error during cancellation");
    const r = classifyStreamError(err, { closed: false }, reply as never, req as never);
    expect(r.finishReason).toBe("cancelled");
    expect(reply.raw.write).not.toHaveBeenCalled();
  });

  it("generic Error → finishReason='error' + emit 'internal' (the cycle-2 fix)", () => {
    const reply = fakeReply();
    const req = fakeReq();
    const err = new Error("something exploded");
    const r = classifyStreamError(err, { closed: false }, reply as never, req as never);
    // The pre-fix bug returned undefined leaving the outer at 'stop' — that
    // mis-marked the failure as a clean stop in last_finish_reason and
    // mis-fired session_end. Fixed in PR #61; this assertion pins it.
    expect(r.finishReason).toBe("error");
    expect(req.log.error).toHaveBeenCalled();
    expect(reply.raw.write).toHaveBeenCalledTimes(1);
    expect(reply.raw.write.mock.calls[0]?.[0]).toContain('"error":"internal"');
  });

  it("conn.closed=true → no SSE write on any branch", () => {
    const reply = fakeReply();
    const req = fakeReq();
    classifyStreamError(new Error("x"), { closed: true }, reply as never, req as never);
    classifyStreamError(new BudgetExceededError("y"), { closed: true }, reply as never, req as never);
    classifyStreamError(new SessionBudgetExceededError("z"), { closed: true }, reply as never, req as never);
    classifyStreamError(new OptimisticLockError("w"), { closed: true }, reply as never, req as never);
    expect(reply.raw.write).not.toHaveBeenCalled();
  });
});
