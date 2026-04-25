// Tests for POST /api/chat — SSE streaming chat endpoint.
//
// Uses Fastify's inject() for in-process HTTP testing.
// Uses StubLlmProvider for deterministic, zero-network LLM responses.
// Uses mockPool() for Postgres isolation.

import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { registerChatRoute } from "../../src/routes/chat.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { mockPool } from "../helpers/mock-pg.js";
import type { Config } from "../../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    AGENT_HOST: "127.0.0.1",
    AGENT_PORT: 3101,
    AGENT_LOG_LEVEL: "silent",
    AGENT_CORS_ORIGINS: "http://localhost:8501",
    AGENT_BODY_LIMIT_BYTES: 1_048_576,
    AGENT_RATE_LIMIT_MAX: 1000,
    AGENT_RATE_LIMIT_WINDOW_MS: 60_000,
    AGENT_CHAT_MAX_STEPS: 5,
    AGENT_TOKEN_BUDGET: 100_000,
    AGENT_CHAT_RATE_LIMIT_MAX: 100,
    AGENT_CHAT_RATE_LIMIT_WINDOW_MS: 60_000,
    AGENT_CHAT_MAX_INPUT_CHARS: 40_000,
    AGENT_CHAT_MAX_HISTORY: 40,
    POSTGRES_HOST: "localhost",
    POSTGRES_PORT: 5432,
    POSTGRES_DB: "chemclaw",
    POSTGRES_USER: "chemclaw",
    POSTGRES_PASSWORD: "test",
    POSTGRES_STATEMENT_TIMEOUT_MS: 15_000,
    POSTGRES_CONNECT_TIMEOUT_MS: 10_000,
    POSTGRES_POOL_SIZE: 5,
    MCP_RDKIT_URL: "http://localhost:8001",
    MCP_DRFP_URL: "http://localhost:8002",
    MCP_KG_URL: "http://localhost:8003",
    MCP_EMBEDDER_URL: "http://localhost:8004",
    MCP_TABICL_URL: "http://localhost:8005",
    LITELLM_BASE_URL: "http://localhost:4000",
    LITELLM_API_KEY: "sk-test",
    AGENT_MODEL: "claude-opus-4-7",
    CHEMCLAW_DEV_MODE: true,
    CHEMCLAW_DEV_USER_EMAIL: "dev@local.test",
    ...overrides,
  };
}

function buildApp(
  llm: StubLlmProvider,
  cfg: Config = makeConfig(),
  promptOverride?: PromptRegistry,
): FastifyInstance {
  const app = Fastify({ logger: false });
  const { pool, client } = mockPool();
  const registry = new ToolRegistry();

  // Make feedback INSERT succeed (withUserContext calls BEGIN, set_config, INSERT, COMMIT).
  client.queryResults.push(
    { rows: [], rowCount: 0 }, // BEGIN
    { rows: [], rowCount: 0 }, // set_config
    { rows: [], rowCount: 1 }, // INSERT feedback_events
    { rows: [], rowCount: 0 }, // COMMIT
  );

  const mockPromptRegistry =
    promptOverride ??
    ({
      getActive: vi.fn().mockResolvedValue({
        template: "You are ChemClaw.",
        version: 1,
      }),
      invalidate: vi.fn(),
    } as unknown as PromptRegistry);

  registerChatRoute(app, {
    config: cfg,
    pool,
    llm,
    registry,
    promptRegistry: mockPromptRegistry,
    getUser: (_req: FastifyRequest) => "dev@local.test",
  });

  return app;
}

// Parse SSE body into typed events.
// The server JSON-encodes newlines as \\n so the wire format is valid SSE.
// inject() returns the raw bytes. We split on "\n\n" to find frames.
function parseSseEvents(body: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const chunks = body.split("\n\n");
  for (const chunk of chunks) {
    const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    const json = dataLine.slice("data:".length).trim();
    if (!json) continue;
    try {
      events.push(JSON.parse(json) as Record<string, unknown>);
    } catch {
      // skip malformed frames
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/chat — slash short-circuit: /help", () => {
  it("returns verb list without calling LLM (stream=false)", async () => {
    const llm = new StubLlmProvider();
    const app = buildApp(llm);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        messages: [{ role: "user", content: "/help" }],
        stream: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { text: string };
    expect(body.text).toContain("/help");
    expect(body.text).toContain("/plan");
    // LLM should NOT have been called.
    expect(llm.pending).toBe(0);
  });

  it("emits SSE events for /help (stream=true)", async () => {
    const llm = new StubLlmProvider();
    const app = buildApp(llm);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        messages: [{ role: "user", content: "/help" }],
        stream: true,
      },
    });

    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = parseSseEvents(res.body);
    expect(events.some((e) => e["type"] === "text_delta")).toBe(true);
    expect(events.some((e) => e["type"] === "finish")).toBe(true);
  });
});

describe("POST /api/chat — slash short-circuit: /feedback", () => {
  it("returns thanks message for valid feedback (stream=false)", async () => {
    const llm = new StubLlmProvider();
    const { pool, client } = mockPool();

    // Set up DB mocks for the feedback INSERT path (BEGIN, set_config, INSERT, COMMIT).
    client.queryResults.push(
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
    );

    const app = Fastify({ logger: false });
    registerChatRoute(app, {
      config: makeConfig(),
      pool,
      llm,
      registry: new ToolRegistry(),
      promptRegistry: { getActive: vi.fn(), invalidate: vi.fn() } as unknown as PromptRegistry,
      getUser: () => "dev@local.test",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        messages: [{ role: "user", content: '/feedback up "excellent"' }],
        stream: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { text: string };
    expect(body.text).toContain("thumbs_up");
  });

  it("returns error text for malformed /feedback (stream=false)", async () => {
    const llm = new StubLlmProvider();
    const app = buildApp(llm);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        messages: [{ role: "user", content: "/feedback" }],
        stream: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { text: string };
    expect(body.text).toContain("Invalid /feedback");
  });
});

describe("POST /api/chat — unknown slash command", () => {
  it("returns an error message for unknown /verb", async () => {
    const llm = new StubLlmProvider();
    const app = buildApp(llm);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        messages: [{ role: "user", content: "/unknownverb" }],
        stream: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { text: string };
    expect(body.text).toContain("/unknownverb");
    expect(body.text).toContain("/help");
  });
});

describe("POST /api/chat — input validation", () => {
  it("returns 400 for an empty body", async () => {
    const llm = new StubLlmProvider();
    const app = buildApp(llm);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("invalid_input");
  });

  it("returns 413 for over-cap history", async () => {
    const llm = new StubLlmProvider();
    const cfg = makeConfig({ AGENT_CHAT_MAX_HISTORY: 2 });
    const app = buildApp(llm, cfg);

    const messages = [
      { role: "user", content: "msg 1" },
      { role: "assistant", content: "resp 1" },
      { role: "user", content: "msg 2" },
    ];

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { messages, stream: false },
    });

    expect(res.statusCode).toBe(413);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("history_too_long");
  });

  it("returns 413 for an over-cap single message", async () => {
    const llm = new StubLlmProvider();
    const cfg = makeConfig({ AGENT_CHAT_MAX_INPUT_CHARS: 10 });
    const app = buildApp(llm, cfg);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        messages: [{ role: "user", content: "x".repeat(20) }],
        stream: false,
      },
    });

    expect(res.statusCode).toBe(413);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("message_too_long");
  });
});

describe("POST /api/chat — terminal-event guarantee", () => {
  it("always emits a finish or error event even when LLM call resolves normally", async () => {
    const llm = new StubLlmProvider();
    llm.enqueueText("Final answer.");
    const app = buildApp(llm);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        messages: [{ role: "user", content: "plain question" }],
        stream: true,
      },
    });

    const events = parseSseEvents(res.body);
    const hasTerminal = events.some(
      (e) => e["type"] === "finish" || e["type"] === "error",
    );
    expect(hasTerminal).toBe(true);
  });
});

describe("POST /api/chat — plan mode", () => {
  it("prepends PLAN PREVIEW to the response for /plan messages (stream=false)", async () => {
    const llm = new StubLlmProvider();
    llm.enqueueText("Here are the steps: 1. Search reactions.");
    const app = buildApp(llm);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        messages: [{ role: "user", content: "/plan optimize amide coupling" }],
        stream: false,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { text: string };
    expect(body.text).toContain("PLAN PREVIEW");
  });
});
