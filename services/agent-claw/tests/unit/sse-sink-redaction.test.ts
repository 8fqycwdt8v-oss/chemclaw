// Locks in the contract that makeSseSink applies redactString to the
// `awaiting_user_input` SSE event. This is the defense-in-depth gap that
// allowed /api/deep_research to leak unredacted clarifying questions —
// the chat route's finally-block scrubbed the question before emitting,
// but DR mode wired the sink directly so the harness's
// streamSink.onAwaitingUserInput?.(err.question) call landed on the wire raw.
//
// By moving the redaction inside makeSseSink, every route that uses the
// shared sink (including future ones) gets defense-in-depth for free.

import { describe, it, expect } from "vitest";
import type { FastifyReply } from "fastify";
import { makeSseSink } from "../../src/streaming/sse-sink.js";
import type { RedactReplacement } from "../../src/core/hooks/redact-secrets.js";

interface CapturedReply {
  reply: FastifyReply;
  writes: string[];
}

function makeCapturedReply(): CapturedReply {
  const writes: string[] = [];
  const reply = {
    raw: {
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    },
  } as unknown as FastifyReply;
  return { reply, writes };
}

function parseEvents(writes: string[]): Array<Record<string, unknown>> {
  return writes
    .map((w) => w.replace(/^data: /, "").trim())
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s) as Record<string, unknown>);
}

describe("makeSseSink — onAwaitingUserInput redaction", () => {
  it("redacts NCE project IDs in the question before writing the SSE frame", () => {
    const { reply, writes } = makeCapturedReply();
    const log: RedactReplacement[] = [];
    const sink = makeSseSink(reply, log, "sess-abc");

    sink.onAwaitingUserInput?.("Should I include NCE-001234 in the report?");

    const events = parseEvents(writes);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev["type"]).toBe("awaiting_user_input");
    expect(ev["session_id"]).toBe("sess-abc");
    const question = ev["question"] as string;
    expect(question).toContain("[REDACTED]");
    expect(question).not.toContain("NCE-001234");
    // Replacements accumulated for post_turn observability.
    expect(log.some((r) => r.original === "NCE-001234")).toBe(true);
  });

  it("redacts CMP compound codes and emails in the question", () => {
    const { reply, writes } = makeCapturedReply();
    const log: RedactReplacement[] = [];
    const sink = makeSseSink(reply, log, "sess-1");

    sink.onAwaitingUserInput?.(
      "Confirm CMP-12345678 from chemist@example.com?",
    );

    const events = parseEvents(writes);
    const question = events[0]?.["question"] as string;
    expect(question).not.toContain("CMP-12345678");
    expect(question).not.toContain("chemist@example.com");
    expect(question).toContain("[REDACTED]");
  });

  it("falls back to empty session id when none provided (stateless turn)", () => {
    const { reply, writes } = makeCapturedReply();
    const log: RedactReplacement[] = [];
    const sink = makeSseSink(reply, log);

    sink.onAwaitingUserInput?.("plain question");

    const events = parseEvents(writes);
    expect(events[0]?.["session_id"]).toBe("");
    expect(events[0]?.["question"]).toBe("plain question");
  });
});
