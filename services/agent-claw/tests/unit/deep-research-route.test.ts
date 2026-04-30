// Tests for POST /api/deep_research — DR mode alias.
//
// Verifies:
//   - Route exists (not 404).
//   - DR system prompt includes the step-by-step suffix.
//   - Response has a finish event (terminal guarantee).
//   - Input validation (400 for invalid body, 413 for over-cap).
//   - stream=false path works.

import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { registerDeepResearchRoute } from "../../src/routes/deep-research.js";
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

function buildApp(llm: StubLlmProvider, cfg: Config = makeConfig()): FastifyInstance {
  const app = Fastify({ logger: false });
  const { pool } = mockPool();

  const mockPromptRegistry = {
    getActive: vi.fn().mockResolvedValue({ template: "You are ChemClaw.", version: 1 }),
    invalidate: vi.fn(),
  } as unknown as PromptRegistry;

  registerDeepResearchRoute(app, {
    config: cfg,
    pool,
    llm,
    registry: new ToolRegistry(),
    promptRegistry: mockPromptRegistry,
    getUser: (_req: FastifyRequest) => "dev@local.test",
  });

  return app;
}

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

describe("POST /api/deep_research — route existence", () => {
  it("returns 200 (not 404) for a valid request (stream=true)", async () => {
    const llm = new StubLlmProvider();
    llm.enqueueText("Deep analysis complete.");
    const app = buildApp(llm);

    const res = await app.inject({
      method: "POST",
      url: "/api/deep_research",
      payload: { messages: [{ role: "user", content: "analyse NCE-001" }], stream: true },
    });

    // Must be 200 or SSE (200 with text/event-stream).
    expect(res.statusCode).toBe(200);
  });

  it("emits a finish event in streaming mode", async () => {
    const llm = new StubLlmProvider();
    llm.enqueueText("Report ready.");
    const app = buildApp(llm);

    const res = await app.inject({
      method: "POST",
      url: "/api/deep_research",
      payload: { messages: [{ role: "user", content: "research" }], stream: true },
    });

    const events = parseSseEvents(res.body);
    expect(events.some((e) => e.type === "finish")).toBe(true);
  });

  it("returns a finish event in non-streaming mode (stream=false)", async () => {
    const llm = new StubLlmProvider();
    llm.enqueueText("Non-streaming DR response.");
    const app = buildApp(llm);

    const res = await app.inject({
      method: "POST",
      url: "/api/deep_research",
      payload: { messages: [{ role: "user", content: "summarise" }], stream: false },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { finishReason: string };
    expect(body.finishReason).toBe("stop");
  });
});

describe("POST /api/deep_research — input validation", () => {
  it("returns 400 for empty body", async () => {
    const llm = new StubLlmProvider();
    const app = buildApp(llm);

    const res = await app.inject({
      method: "POST",
      url: "/api/deep_research",
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

    const res = await app.inject({
      method: "POST",
      url: "/api/deep_research",
      payload: {
        messages: [
          { role: "user", content: "msg 1" },
          { role: "assistant", content: "resp 1" },
          { role: "user", content: "msg 2" },
        ],
        stream: false,
      },
    });

    expect(res.statusCode).toBe(413);
  });
});

describe("POST /api/deep_research — DR mode marker", () => {
  it("injects DR suffix into the system prompt (log assertion via mock)", async () => {
    const llm = new StubLlmProvider();
    llm.enqueueText("DR done.");
    const { pool } = mockPool();
    const app = Fastify({ logger: false });

    // Capture the messages the LLM sees by intercepting call().
    const originalCall = llm.call.bind(llm);
    let capturedMessages: Array<{ role: string; content: string }> = [];
    vi.spyOn(llm, "call").mockImplementation(async (msgs, tools) => {
      capturedMessages = msgs;
      return await originalCall(msgs, tools);
    });

    registerDeepResearchRoute(app, {
      config: makeConfig(),
      pool,
      llm,
      registry: new ToolRegistry(),
      promptRegistry: {
        getActive: vi.fn().mockResolvedValue({ template: "Base system prompt.", version: 1 }),
        invalidate: vi.fn(),
      } as unknown as PromptRegistry,
      getUser: () => "dev@local.test",
    });

    await app.inject({
      method: "POST",
      url: "/api/deep_research",
      payload: { messages: [{ role: "user", content: "research" }], stream: false },
    });

    // The system message should contain the DR suffix.
    const systemMsg = capturedMessages.find((m) => m.role === "system");
    expect(systemMsg?.content).toContain("DR mode");
    expect(systemMsg?.content).toContain("structured report");
  });
});
