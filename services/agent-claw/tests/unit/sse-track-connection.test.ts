// Tests for trackConnection — the SSE close/aborted-listener helper that
// replaced three near-identical inline implementations across chat.ts,
// plan.ts, and deep-research.ts.
//
// Pre-PR plan.ts only listened on `close`, missing `aborted` — a real bug
// for HTTP/1.0-style mid-stream resets. These tests pin the dual-listener
// invariant so a future refactor can't silently drop one.

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { trackConnection } from "../../src/streaming/sse.js";
import type { FastifyRequest } from "fastify";

function fakeReq(): { req: FastifyRequest; raw: EventEmitter } {
  const raw = new EventEmitter();
  return { req: { raw } as unknown as FastifyRequest, raw };
}

describe("trackConnection", () => {
  it("returns { closed: false } before any event fires", () => {
    const { req } = fakeReq();
    const conn = trackConnection(req);
    expect(conn.closed).toBe(false);
  });

  it("flips closed=true on `close`", () => {
    const { req, raw } = fakeReq();
    const conn = trackConnection(req);
    raw.emit("close");
    expect(conn.closed).toBe(true);
  });

  it("flips closed=true on `aborted` even if `close` never fires", () => {
    // Regression for plan.ts: pre-PR, only `close` was listened to, so an
    // HTTP/1.0 mid-stream abort would leave conn.closed=false and the
    // subsequent writeEvent would throw past the guard.
    const { req, raw } = fakeReq();
    const conn = trackConnection(req);
    raw.emit("aborted");
    expect(conn.closed).toBe(true);
  });

  it("flips closed=true on `error` (TCP reset / TLS failure)", () => {
    // Regression: pre-PR the helper relied on Fastify's outer request
    // error handler to catch the EventEmitter no-listener throw — works
    // today but the harness loop continued spinning past the disconnect.
    const { req, raw } = fakeReq();
    const conn = trackConnection(req);
    raw.emit("error", new Error("ECONNRESET"));
    expect(conn.closed).toBe(true);
  });

  it("idempotent: multiple events do not throw", () => {
    const { req, raw } = fakeReq();
    const conn = trackConnection(req);
    raw.emit("close");
    raw.emit("aborted");
    raw.emit("close");
    expect(conn.closed).toBe(true);
  });

  it("each invocation returns an independent state box", () => {
    const a = fakeReq();
    const b = fakeReq();
    const connA = trackConnection(a.req);
    const connB = trackConnection(b.req);
    a.raw.emit("close");
    expect(connA.closed).toBe(true);
    expect(connB.closed).toBe(false);
  });
});
