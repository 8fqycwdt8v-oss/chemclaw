// review-v2 cycle-2: pin emitTerminalEvents' ordering contract.
// The cancelled-then-finish pair is load-bearing per chat-streaming-sse.ts:
// a buffering SSE proxy must see BOTH signals when a turn cancels mid-stream,
// and the order must always be cancelled then finish.

import { describe, it, expect, vi } from "vitest";
import { emitTerminalEvents } from "../../src/routes/chat-streaming-sse.js";
import type { Budget } from "../../src/core/budget.js";

function makeReply() {
  const writes: string[] = [];
  const reply = {
    raw: {
      writableEnded: false,
      write: vi.fn().mockImplementation((data: string) => {
        writes.push(data);
        return true;
      }),
    },
  };
  return { reply, writes };
}

function fakeBudget(prompt = 100, completion = 50): Budget {
  return {
    summary: vi.fn().mockReturnValue({ promptTokens: prompt, completionTokens: completion }),
  } as unknown as Budget;
}

describe("emitTerminalEvents — ordering and gating", () => {
  it("emits cancelled BEFORE finish when finishReason='cancelled'", () => {
    const { reply, writes } = makeReply();
    emitTerminalEvents({
      reply: reply as never,
      conn: { closed: false },
      finishReason: "cancelled",
      budget: fakeBudget(),
      sessionId: "session-x",
    });
    expect(writes).toHaveLength(2);
    // Order is load-bearing: cancelled MUST come first.
    expect(writes[0]).toContain('"type":"cancelled"');
    expect(writes[0]).toContain('"session_id":"session-x"');
    expect(writes[1]).toContain('"type":"finish"');
    expect(writes[1]).toContain('"finishReason":"cancelled"');
  });

  it("emits ONLY finish (no cancelled) when finishReason='stop'", () => {
    const { reply, writes } = makeReply();
    emitTerminalEvents({
      reply: reply as never,
      conn: { closed: false },
      finishReason: "stop",
      budget: fakeBudget(),
      sessionId: "session-x",
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"type":"finish"');
    expect(writes[0]).toContain('"finishReason":"stop"');
  });

  it("emits NEITHER cancelled nor finish when conn.closed=true", () => {
    const { reply, writes } = makeReply();
    emitTerminalEvents({
      reply: reply as never,
      conn: { closed: true },
      finishReason: "cancelled",
      budget: fakeBudget(),
      sessionId: "session-x",
    });
    expect(writes).toHaveLength(0);
  });

  it("uses {0,0} usage fallback when budget is undefined", () => {
    const { reply, writes } = makeReply();
    emitTerminalEvents({
      reply: reply as never,
      conn: { closed: false },
      finishReason: "stop",
      budget: undefined,
      sessionId: null,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"promptTokens":0');
    expect(writes[0]).toContain('"completionTokens":0');
  });

  it("omits session_id from cancelled event when sessionId is null", () => {
    const { reply, writes } = makeReply();
    emitTerminalEvents({
      reply: reply as never,
      conn: { closed: false },
      finishReason: "cancelled",
      budget: fakeBudget(),
      sessionId: null,
    });
    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain('"type":"cancelled"');
    expect(writes[0]).not.toContain("session_id");
  });

  it("threads the budget summary into the finish event's usage shape", () => {
    const { reply, writes } = makeReply();
    emitTerminalEvents({
      reply: reply as never,
      conn: { closed: false },
      finishReason: "stop",
      budget: fakeBudget(123, 456),
      sessionId: null,
    });
    expect(writes[0]).toContain('"promptTokens":123');
    expect(writes[0]).toContain('"completionTokens":456');
  });
});
