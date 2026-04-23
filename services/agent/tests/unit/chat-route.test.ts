// Unit tests for POST /api/chat — bounds enforcement.
//
// We mount the route on an in-memory Fastify app with a stub ChatAgent and
// stub auth. The agent is a no-op; the test focuses on request validation,
// not on streaming behaviour (streaming is covered by chat-agent.test.ts).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";

import { registerChatRoute } from "../../src/routes/chat.js";

async function buildApp(overrides: Partial<any> = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(rateLimit, { max: 1000, timeWindow: 60_000 });

  const stubAgent: any = {
    generate: async () => ({ text: "ok", finishReason: "stop", promptVersion: 1 }),
    stream: async function* () {
      yield { type: "finish", finishReason: "stop", usage: {}, promptVersion: 1 };
    },
  };

  registerChatRoute(app, {
    config: {
      AGENT_CHAT_RATE_LIMIT_MAX: 1000,
      AGENT_CHAT_RATE_LIMIT_WINDOW_MS: 60_000,
      AGENT_CHAT_MAX_HISTORY: 5,
      AGENT_CHAT_MAX_INPUT_CHARS: 100,
    } as any,
    agent: stubAgent,
    getUser: () => "test@example.com",
    ...overrides,
  });
  await app.ready();
  return app;
}

describe("POST /api/chat", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("rejects empty messages array", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { messages: [], stream: false },
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects unknown roles", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        messages: [{ role: "robot", content: "hi" }],
        stream: false,
      },
    });
    expect(r.statusCode).toBe(400);
  });

  it("413 when history exceeds max", async () => {
    const msgs = Array.from({ length: 6 }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
    }));
    const r = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { messages: msgs, stream: false },
    });
    expect(r.statusCode).toBe(413);
    expect(r.json()).toMatchObject({ error: "history_too_long" });
  });

  it("413 when message content exceeds cap", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        messages: [{ role: "user", content: "x".repeat(101) }],
        stream: false,
      },
    });
    expect(r.statusCode).toBe(413);
    expect(r.json()).toMatchObject({ error: "message_too_long" });
  });

  it("200 and JSON body for stream=false happy path", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ text: "ok", finishReason: "stop" });
  });
});
