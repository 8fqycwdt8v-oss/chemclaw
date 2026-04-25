// Regression test: /api/deep_research has been removed. These two tests
// confirm (a) the deleted route returns 404 and (b) /api/chat still exists.
//
// We use the same idiom as chat-route.test.ts: build an in-memory Fastify app
// with registerChatRoute mounted, then inject requests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";

import { registerChatRoute } from "../../src/routes/chat.js";

async function buildApp(): Promise<FastifyInstance> {
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
      AGENT_CHAT_MAX_HISTORY: 40,
      AGENT_CHAT_MAX_INPUT_CHARS: 80_000,
    } as any,
    agent: stubAgent,
    getUser: () => "test@example.com",
  });
  await app.ready();
  return app;
}

describe("/api/deep_research deletion", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 404 for POST /api/deep_research", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/deep_research",
      payload: { messages: [] },
    });
    expect(r.statusCode).toBe(404);
  });

  it("still serves POST /api/chat", async () => {
    const r = await app.inject({ method: "POST", url: "/api/chat" });
    // 400 (body missing/invalid) is acceptable — the route exists and
    // processes the request; a missing body yields a validation error.
    expect([400, 415]).toContain(r.statusCode);
  });
});
