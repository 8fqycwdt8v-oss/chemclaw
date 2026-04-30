// Cycle-2 review regression test: `writeEvent` must short-circuit when
// the response stream is already ended. Node's OutgoingMessage.write
// after end does NOT throw synchronously — it returns false and emits
// an async `error` event for ERR_STREAM_WRITE_AFTER_END that the
// caller's try/catch cannot catch. The fix guards on
// reply.raw.writableEnded so post-end writes are a clean no-op.
//
// Real-world trigger: chat-plan-mode.ts inner finally calls
// reply.raw.end(), then chat.ts outer finally invokes emitTerminalEvents
// which would otherwise write to a closed stream.

import { describe, it, expect, vi } from "vitest";
import { writeEvent } from "../../src/streaming/sse.js";

describe("writeEvent — write-after-end guard", () => {
  it("does not call reply.raw.write when writableEnded is true", () => {
    const writeFn = vi.fn();
    const fakeReply = {
      raw: {
        writableEnded: true,
        write: writeFn,
      },
    };
    writeEvent(fakeReply as never, { type: "finish", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } });
    expect(writeFn).not.toHaveBeenCalled();
  });

  it("calls reply.raw.write when writableEnded is false", () => {
    const writeFn = vi.fn();
    const fakeReply = {
      raw: {
        writableEnded: false,
        write: writeFn,
      },
    };
    writeEvent(fakeReply as never, { type: "finish", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } });
    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(writeFn).toHaveBeenCalledWith(expect.stringContaining('"type":"finish"'));
  });

  it("escapes newlines in payload JSON", () => {
    const writeFn = vi.fn();
    const fakeReply = { raw: { writableEnded: false, write: writeFn } };
    writeEvent(fakeReply as never, { type: "text_delta", delta: "line1\nline2" });
    const written = writeFn.mock.calls[0]?.[0] as string;
    // The literal newline inside the payload must be escaped so SSE
    // framing isn't broken — line1\nline2 → line1\\nline2 in the wire.
    expect(written).toContain("line1\\nline2");
    // The trailing event terminator (one literal newline) is part of
    // SSE framing and stays unescaped.
    expect(written.endsWith("\n\n")).toBe(true);
  });
});
