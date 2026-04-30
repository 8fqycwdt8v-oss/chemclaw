// Tests for the working-memory compactor — Phase C.1

import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  shouldCompact,
  compact,
} from "../../src/core/compactor.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import type { Message } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessages(count: number, includeSystem = true): Message[] {
  const msgs: Message[] = [];
  if (includeSystem) {
    msgs.push({ role: "system", content: "You are ChemClaw." });
  }
  for (let i = 0; i < count; i++) {
    msgs.push({ role: "user", content: `User message ${i} with some content.` });
    msgs.push({ role: "assistant", content: `Assistant reply ${i} with data.` });
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns 0 for empty array", () => {
    expect(estimateTokens([])).toBe(0);
  });

  it("estimates ~1/4 of total character count", () => {
    const msgs: Message[] = [
      { role: "user", content: "1234" },   // 4 chars → 1 token
      { role: "assistant", content: "abcd" }, // 4 chars → 1 token
    ];
    expect(estimateTokens(msgs)).toBe(2);
  });

  it("rounds up for fractional token counts", () => {
    const msgs: Message[] = [
      { role: "user", content: "abc" }, // 3 chars → ceil(3/4) = 1
    ];
    expect(estimateTokens(msgs)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// shouldCompact
// ---------------------------------------------------------------------------

describe("shouldCompact", () => {
  it("returns false when estimate is well below threshold", () => {
    const msgs: Message[] = [{ role: "user", content: "hello" }];
    // 5 chars → ~2 tokens; budget 1000 * 0.60 = 600 → not triggered
    expect(shouldCompact(msgs, 1000)).toBe(false);
  });

  it("returns true when estimate exceeds 60% threshold", () => {
    // 2400 chars → 600 tokens; budget 999 * 0.60 = 599.4 → triggered
    const content = "x".repeat(2400);
    const msgs: Message[] = [{ role: "user", content }];
    expect(shouldCompact(msgs, 999)).toBe(true);
  });

  it("respects a custom trigger fraction", () => {
    // 400 chars → 100 tokens; budget 1000 * 0.08 = 80 → triggered at 8%
    const content = "x".repeat(400);
    const msgs: Message[] = [{ role: "user", content }];
    expect(shouldCompact(msgs, 1000, 0.08)).toBe(true);
    // At 0.20 (200 tokens threshold): NOT triggered
    expect(shouldCompact(msgs, 1000, 0.20)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compact — with StubLlmProvider returning a canned synopsis
// ---------------------------------------------------------------------------

describe("compact", () => {
  const CANNED_SYNOPSIS = "Earlier: user asked about compound CCO; agent found fact_id abc-123 with yield 82%.";

  function makeLlm(): StubLlmProvider {
    const llm = new StubLlmProvider();
    llm.enqueueJson({ synopsis: CANNED_SYNOPSIS });
    return llm;
  }

  it("leaves messages unchanged when too few non-system messages", async () => {
    const llm = makeLlm();
    const msgs = makeMessages(1, true); // system + 2 messages (≤ recentKeep=3)
    const result = await compact(msgs, { tokenBudget: 1000, llm, recentKeep: 3 });
    // Nothing to compact — should return same content
    expect(result).toEqual(msgs);
  });

  it("preserves system prompt at index 0", async () => {
    const llm = makeLlm();
    const msgs = makeMessages(4, true); // system + 8 messages (> recentKeep=3)
    const result = await compact(msgs, { tokenBudget: 1000, llm, recentKeep: 3 });
    expect(result[0]?.role).toBe("system");
    expect(result[0]?.content).toBe("You are ChemClaw.");
  });

  it("inserts a synopsis system message after the system prompt", async () => {
    const llm = makeLlm();
    const msgs = makeMessages(4, true);
    const result = await compact(msgs, { tokenBudget: 1000, llm, recentKeep: 3 });
    expect(result[1]?.role).toBe("system");
    expect(result[1]?.content).toContain("Earlier in this conversation:");
    expect(result[1]?.content).toContain(CANNED_SYNOPSIS);
  });

  it("keeps the most recent N=3 messages after the synopsis", async () => {
    const llm = makeLlm();
    const msgs = makeMessages(4, true); // system + 8 non-system messages
    const result = await compact(msgs, { tokenBudget: 1000, llm, recentKeep: 3 });
    const _nonSystem = result.filter((m) => m.role !== "system" || result.indexOf(m) > 1);
    // After system (index 0) and synopsis (index 1), we should have 3 recent messages.
    const afterSynopsis = result.slice(2);
    expect(afterSynopsis.length).toBe(3);
  });

  it("falls back to truncated transcript if LLM throws", async () => {
    const llm = new StubLlmProvider();
    // Don't enqueue anything — completeJson will return {} (default stub)
    // The compactor should fall back gracefully.
    const msgs = makeMessages(4, true);
    const result = await compact(msgs, { tokenBudget: 1000, llm, recentKeep: 3 });
    // Should still return a valid 3-message tail.
    const afterSynopsis = result.slice(2);
    expect(afterSynopsis.length).toBe(3);
  });

  it("handles messages with no system prompt", async () => {
    const llm = makeLlm();
    const msgs = makeMessages(4, false); // no system message
    const result = await compact(msgs, { tokenBudget: 1000, llm, recentKeep: 3 });
    // Synopsis should be first (no system to preserve).
    expect(result[0]?.role).toBe("system");
    expect(result[0]?.content).toContain("Earlier in this conversation:");
  });

  it("returns empty array for empty input", async () => {
    const llm = makeLlm();
    const result = await compact([], { tokenBudget: 1000, llm });
    expect(result).toEqual([]);
  });
});
