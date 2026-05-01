import { describe, expect, it } from "vitest";

import { runWithRequestContext } from "../../src/core/request-context.js";
import { ERROR_CODES } from "../../src/errors/codes.js";
import { envelopeFor, toEnvelope } from "../../src/errors/envelope.js";

class FakeBudgetExceeded extends Error {
  constructor() {
    super("budget hit");
    this.name = "BudgetExceededError";
  }
}

describe("toEnvelope", () => {
  it("maps a known error class to its stable code", () => {
    const env = toEnvelope(new FakeBudgetExceeded());
    expect(env.error).toBe(ERROR_CODES.AGENT_BUDGET_EXCEEDED);
    expect(env.message).toBe("budget hit");
  });

  it("falls back to AGENT_INTERNAL for unknown errors", () => {
    const env = toEnvelope(new Error("unexpected"));
    expect(env.error).toBe(ERROR_CODES.AGENT_INTERNAL);
    expect(env.message).toBe("unexpected");
  });

  it("respects the fallbackCode option for unknown errors", () => {
    const env = toEnvelope(new Error("oops"), {
      fallbackCode: ERROR_CODES.AGENT_TOOL_FAILED,
    });
    expect(env.error).toBe(ERROR_CODES.AGENT_TOOL_FAILED);
  });

  it("attaches optional detail + hint when supplied", () => {
    const env = toEnvelope(new Error("x"), {
      detail: { tool_id: "compute_drfp" },
      hint: "retry once",
    });
    expect(env.detail).toEqual({ tool_id: "compute_drfp" });
    expect(env.hint).toBe("retry once");
  });

  it("includes request_id when called inside a RequestContext", async () => {
    await runWithRequestContext(
      { userEntraId: "u", requestId: "req-Z" },
      async () => {
        const env = toEnvelope(new Error("fail"));
        expect(env.request_id).toBe("req-Z");
      },
    );
  });

  it("envelopeFor stamps the requested code verbatim", () => {
    const env = envelopeFor(ERROR_CODES.MCP_TIMEOUT, "tool timed out", {
      hint: "retry with fewer molecules",
    });
    expect(env.error).toBe(ERROR_CODES.MCP_TIMEOUT);
    expect(env.message).toBe("tool timed out");
    expect(env.hint).toBe("retry with fewer molecules");
  });

  it("does not include trace_id when no OTel span is active", () => {
    const env = toEnvelope(new Error("none"));
    expect(env.trace_id).toBeUndefined();
  });

  it("does not contain raw user data", async () => {
    await runWithRequestContext(
      { userEntraId: "alice@example.com", requestId: "r1" },
      async () => {
        const env = toEnvelope(new Error("oops"));
        expect(JSON.stringify(env)).not.toContain("alice");
      },
    );
  });
});
