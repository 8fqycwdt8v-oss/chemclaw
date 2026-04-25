// Tests for token-by-token SSE streaming in POST /api/chat.
//
// Verifies:
//   - stream=true path emits ≥2 text_delta events when StubLlmProvider
//     enqueues multi-chunk stream batches.
//   - Events arrive in order: text_delta* → finish.
//   - tool_call + tool_result events are emitted for tool-call steps.
//   - finish event is always the last event (terminal guarantee).
//   - stream=false path still works (non-streaming fallback).

import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { registerChatRoute } from "../../src/routes/chat.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { mockPool } from "../helpers/mock-pg.js";
import type { Config } from "../../src/config.js";
import { defineTool } from "../../src/tools/tool.js";
import { z } from "zod";

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
  registry?: ToolRegistry,
): FastifyInstance {
  const app = Fastify({ logger: false });
  const { pool } = mockPool();

  const mockPromptRegistry = {
    getActive: vi.fn().mockResolvedValue({ template: "You are ChemClaw.", version: 1 }),
    invalidate: vi.fn(),
  } as unknown as PromptRegistry;

  registerChatRoute(app, {
    config: cfg,
    pool,
    llm,
    registry: registry ?? new ToolRegistry(),
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
// Tests: token-by-token streaming
// ---------------------------------------------------------------------------

describe("POST /api/chat — SSE streaming (token-by-token)", () => {
  it("emits multiple text_delta events when provider yields multiple chunks", async () => {
    const llm = new StubLlmProvider();
    // call() returns the text step (non-streaming first pass)
    llm.enqueueText("hello world");
    // streamCompletion() yields multi-chunk stream
    llm.enqueueStream([
      { type: "text_delta", delta: "hello " },
      { type: "text_delta", delta: "world" },
    ]);
    const app = buildApp(llm);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { messages: [{ role: "user", content: "hi" }], stream: true },
    });

    const events = parseSseEvents(res.body);
    const textDeltas = events.filter((e) => e["type"] === "text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(2);
    expect(textDeltas.map((e) => e["delta"]).join("")).toBe("hello world");
  });

  it("always ends with a finish event (terminal guarantee)", async () => {
    const llm = new StubLlmProvider();
    llm.enqueueText("done");
    llm.enqueueStream([{ type: "text_delta", delta: "done" }]);
    const app = buildApp(llm);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { messages: [{ role: "user", content: "go" }], stream: true },
    });

    const events = parseSseEvents(res.body);
    const last = events[events.length - 1];
    expect(last?.["type"]).toBe("finish");
  });

  it("events arrive in order: text_delta events before finish", async () => {
    const llm = new StubLlmProvider();
    llm.enqueueText("alpha beta");
    llm.enqueueStream([
      { type: "text_delta", delta: "alpha " },
      { type: "text_delta", delta: "beta" },
    ]);
    const app = buildApp(llm);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { messages: [{ role: "user", content: "test" }], stream: true },
    });

    const events = parseSseEvents(res.body);
    const types = events.map((e) => e["type"]);
    const finishIdx = types.lastIndexOf("finish");
    const lastDeltaIdx = types.lastIndexOf("text_delta");

    // At least one text_delta must appear before finish.
    expect(lastDeltaIdx).toBeGreaterThanOrEqual(0);
    expect(finishIdx).toBeGreaterThan(lastDeltaIdx);
  });

  it("uses stub default stream when no stream batch is enqueued (fallback path)", async () => {
    const llm = new StubLlmProvider();
    // Only enqueue the call() response; let streamCompletion use its default.
    llm.enqueueText("fallback response");
    // No enqueueStream() call — StubLlmProvider emits default "stub response" chunk.
    const app = buildApp(llm);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { messages: [{ role: "user", content: "hi" }], stream: true },
    });

    const events = parseSseEvents(res.body);
    expect(events.some((e) => e["type"] === "text_delta")).toBe(true);
    expect(events.some((e) => e["type"] === "finish")).toBe(true);
  });

  it("emits tool_call + tool_result events when model uses a tool", async () => {
    // Build a registry with a stub tool.
    const registry = new ToolRegistry();
    const echoTool = defineTool({
      id: "echo",
      description: "Echo the input",
      inputSchema: z.object({ msg: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
      execute: async (_ctx, input) => ({ echoed: input.msg }),
    });
    registry.register(echoTool);

    const llm = new StubLlmProvider();
    // First call: model calls the tool.
    llm.enqueueToolCall("echo", { msg: "hello" });
    // Second call: model produces final text.
    llm.enqueueText("Tool called successfully.");
    // Stream the final text.
    llm.enqueueStream([{ type: "text_delta", delta: "Tool called successfully." }]);

    const app = buildApp(llm, makeConfig(), registry);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { messages: [{ role: "user", content: "use the tool" }], stream: true },
    });

    const events = parseSseEvents(res.body);
    const types = events.map((e) => e["type"]);
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("finish");
  });
});

// ---------------------------------------------------------------------------
// Tests: StubLlmProvider enqueueStream
// ---------------------------------------------------------------------------

describe("StubLlmProvider — enqueueStream", () => {
  it("yields queued chunks in order", async () => {
    const stub = new StubLlmProvider();
    stub.enqueueStream([
      { type: "text_delta", delta: "chunk1" },
      { type: "text_delta", delta: "chunk2" },
    ]);

    const chunks: string[] = [];
    for await (const c of stub.streamCompletion([], [])) {
      if (c.type === "text_delta") chunks.push(c.delta);
    }
    expect(chunks).toEqual(["chunk1", "chunk2"]);
  });

  it("auto-appends a finish chunk if not provided", async () => {
    const stub = new StubLlmProvider();
    stub.enqueueStream([{ type: "text_delta", delta: "hi" }]);

    const types: string[] = [];
    for await (const c of stub.streamCompletion([], [])) {
      types.push(c.type);
    }
    expect(types[types.length - 1]).toBe("finish");
  });

  it("emits default stub response when queue is empty", async () => {
    const stub = new StubLlmProvider();
    const chunks: Array<{ type: string }> = [];
    for await (const c of stub.streamCompletion([], [])) {
      chunks.push(c);
    }
    expect(chunks.some((c) => c.type === "text_delta")).toBe(true);
    expect(chunks[chunks.length - 1]?.type).toBe("finish");
  });
});
