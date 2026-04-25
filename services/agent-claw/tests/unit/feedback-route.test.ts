// Vitest tests for POST /api/feedback.
// Uses an in-memory mock pool to avoid hitting Postgres.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerFeedbackRoute } from "../../src/routes/feedback.js";
import type { FastifyRequest } from "fastify";

// ---------------------------------------------------------------------------
// Mock pool
// ---------------------------------------------------------------------------

function makeMockPool(shouldFail = false) {
  return {
    connect: vi.fn().mockResolvedValue({
      query: shouldFail
        ? vi.fn().mockRejectedValue(new Error("DB error"))
        : vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
      release: vi.fn(),
    }),
    query: shouldFail
      ? vi.fn().mockRejectedValue(new Error("DB error"))
      : vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
  } as unknown as import("pg").Pool;
}

function buildApp(pool: import("pg").Pool, langfuseHost?: string) {
  const app = Fastify({ logger: false });

  // Minimal RLS shim: SET LOCAL is a no-op in the mock.
  registerFeedbackRoute(app, {
    pool,
    getUser: (_req: FastifyRequest) => "test-user@chemclaw.test",
    langfuseHost,
    langfusePublicKey: langfuseHost ? "pk-test" : undefined,
    langfuseSecretKey: langfuseHost ? "sk-test" : undefined,
  });

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 for a valid 'up' signal", async () => {
    const app = buildApp(makeMockPool());
    const resp = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { signal: "up", reason: "Great answer!" },
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(body["signal"]).toBe("up");
  });

  it("returns 200 for a valid 'down' signal with trace_id", async () => {
    const app = buildApp(makeMockPool());
    const resp = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { signal: "down", trace_id: "abc-trace-123", reason: "Missed the impurity" },
    });
    expect(resp.statusCode).toBe(200);
  });

  it("returns 400 for missing signal", async () => {
    const app = buildApp(makeMockPool());
    const resp = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { reason: "no signal here" },
    });
    expect(resp.statusCode).toBe(400);
  });

  it("returns 400 for invalid signal value", async () => {
    const app = buildApp(makeMockPool());
    const resp = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { signal: "neutral" },
    });
    expect(resp.statusCode).toBe(400);
  });

  it("caps reason at 500 chars", async () => {
    const app = buildApp(makeMockPool());
    const longReason = "x".repeat(501);
    const resp = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { signal: "down", reason: longReason },
    });
    // Zod rejects strings longer than 500 chars
    expect(resp.statusCode).toBe(400);
  });

  it("returns 500 when DB write fails", async () => {
    const app = buildApp(makeMockPool(true));
    const resp = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { signal: "up" },
    });
    expect(resp.statusCode).toBe(500);
  });
});
