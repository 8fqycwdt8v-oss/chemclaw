// Vitest tests for crossModelAgreement() in core/confidence.ts.
// Uses a stub LLM provider to avoid real model calls.

import { describe, it, expect } from "vitest";
import { crossModelAgreement, type CrossModelLlmProvider } from "../../src/core/confidence.js";

// ---------------------------------------------------------------------------
// Stub implementations of CrossModelLlmProvider
// ---------------------------------------------------------------------------

function makeLlm(response: unknown, shouldThrow = false): CrossModelLlmProvider {
  return {
    async completeJson(_opts) {
      if (shouldThrow) throw new Error("LLM call failed");
      return response;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("crossModelAgreement", () => {
  it("returns a valid score when judge returns {agreement: 0.9}", async () => {
    const llm = makeLlm({ agreement: 0.9 });
    const score = await crossModelAgreement("The yield was 87%.", llm);
    expect(score).toBe(0.9);
  });

  it("returns null when the judge response has no agreement field", async () => {
    const llm = makeLlm({ something_else: "foo" });
    const score = await crossModelAgreement("Some answer.", llm);
    expect(score).toBeNull();
  });

  it("returns null when the LLM throws", async () => {
    const llm = makeLlm(null, true);
    const score = await crossModelAgreement("Some answer.", llm);
    expect(score).toBeNull();
  });

  it("returns null for out-of-range agreement value", async () => {
    const llm = makeLlm({ agreement: 1.5 });
    const score = await crossModelAgreement("Some answer.", llm);
    expect(score).toBeNull();
  });

  it("rounds score to 3 decimal places", async () => {
    const llm = makeLlm({ agreement: 0.12345 });
    const score = await crossModelAgreement("Some text.", llm);
    expect(score).toBe(0.123);
  });

  it("handles 0.0 agreement (fully disagreeing)", async () => {
    const llm = makeLlm({ agreement: 0 });
    const score = await crossModelAgreement("Some text.", llm);
    expect(score).toBe(0);
  });

  it("returns null for null response from LLM", async () => {
    const llm = makeLlm(null);
    const score = await crossModelAgreement("Some text.", llm);
    expect(score).toBeNull();
  });

  it("truncates long text to 2000 chars before sending", async () => {
    let receivedUser = "";
    const llm: CrossModelLlmProvider = {
      async completeJson(opts) {
        receivedUser = opts.user;
        return { agreement: 0.7 };
      },
    };
    const longText = "x".repeat(5000);
    await crossModelAgreement(longText, llm);
    // The user prompt should reference at most 2000 chars of the original text.
    expect(receivedUser.length).toBeLessThanOrEqual(2100); // 2000 + prompt prefix
  });
});
