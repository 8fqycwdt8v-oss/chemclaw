// Phase 2C — end-to-end integration test for the streaming /api/chat path.
//
// Locks the contract established by Phase 2B: a streamed turn that includes
// one tool call must drive the full pipeline
//
//   route → runHarness → stepOnce → tool execute → SseSink → SSE wire frames
//
// and emit the canonical event sequence in order:
//
//   session → tool_call → tool_result → text_delta → finish
//
// Existing unit tests (streaming-chat.test.ts, deep-research-route.test.ts)
// exercise SSE shape in isolation. Neither catches a regression that
// silently bypasses runHarness — e.g. someone reintroducing a hand-rolled
// loop in chat.ts that forgets onSession would still produce a "valid"
// SSE shape but skip the harness's session emit. This test asserts the
// runHarness-only path by relying on the harness's onSession callback
// being the SOLE driver of the `session` SSE event in the streamed branch.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { registerChatRoute } from "../../src/routes/chat.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { SkillLoader } from "../../src/core/skills.js";
import { lifecycle } from "../../src/core/runtime.js";
import { loadHooks } from "../../src/core/hook-loader.js";
import { defineTool } from "../../src/tools/tool.js";
import { createMockPool } from "../helpers/mock-pool.js";
import { mockHookDeps } from "../helpers/mocks.js";
import type { Config } from "../../src/config.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const hooksDir = resolve(repoRoot, "hooks");

function makeConfig(): Config {
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
    CHEMCLAW_DEV_USER_EMAIL: "test-user",
  };
}

// SSE frames are `data: <json>\n\n`; split on the blank-line separator and
// JSON-parse each `data:` line. Mirrors parseSseEvents in streaming-chat.test.ts.
function parseSse(body: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const chunk of body.split("\n\n")) {
    const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    const json = dataLine.slice("data:".length).trim();
    if (!json) continue;
    try {
      events.push(JSON.parse(json) as Record<string, unknown>);
    } catch {
      // skip malformed
    }
  }
  return events;
}

describe("integration: /api/chat streaming routes through runHarness", () => {
  beforeEach(() => {
    // The route reads the global runtime lifecycle. Reset + populate from
    // the on-disk YAML so the test exercises the same hooks production runs.
    lifecycle.clear();
  });
  afterEach(() => {
    lifecycle.clear();
  });

  it("emits session → tool_call → tool_result → text_delta → finish in order", async () => {
    // Pool: createSession needs an INSERT ... RETURNING id to produce a row.
    // Other queries (saveSession etc.) can no-op with the default empty result.
    const sessionUuid = "11111111-2222-3333-4444-555555555555";
    const { pool } = createMockPool({
      dataHandler: async (sql) => {
        if (/INSERT INTO agent_sessions/i.test(sql)) {
          return { rows: [{ id: sessionUuid }], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 0 } as never;
      },
    });

    // Real registry with a single mock tool the LLM will "call".
    const registry = new ToolRegistry();
    const searchKnowledge = defineTool({
      id: "search_knowledge",
      description: "Search the knowledge graph (test stub).",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ ok: z.literal(true), hits: z.array(z.string()) }),
      execute: async () => ({ ok: true as const, hits: ["doc-1"] }),
    });
    registry.register(searchKnowledge);

    // Real lifecycle populated from the on-disk YAML — same as production.
    // mockHookDeps gives throwing-Proxy stubs by default; pass the real pool
    // (source-cache hook needs it) and a real SkillLoader (apply-skills reads
    // .activeIds in pre_turn).
    await loadHooks(
      lifecycle,
      mockHookDeps({ pool, skillLoader: new SkillLoader(), allTools: registry.all() }),
      hooksDir,
    );

    // LLM stub: 1) tool_call, 2) final text. Then a stream batch for the
    // streamed text replay (call-then-stream pattern in stepOnce).
    const llm = new StubLlmProvider()
      .enqueueToolCall("search_knowledge", { query: "hi" })
      .enqueueText("done")
      .enqueueStream([{ type: "text_delta", delta: "done" }]);

    const promptRegistry = {
      getActive: vi.fn().mockResolvedValue({ template: "You are ChemClaw.", version: 1 }),
      invalidate: vi.fn(),
    } as unknown as PromptRegistry;

    const app: FastifyInstance = Fastify({ logger: false });
    registerChatRoute(app, {
      config: makeConfig(),
      pool,
      llm,
      registry,
      promptRegistry,
      getUser: (_req: FastifyRequest) => "test-user",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { accept: "text/event-stream", "x-user-entra-id": "test-user" },
      payload: { messages: [{ role: "user", content: "hi" }] },
    });

    const events = parseSse(res.body);
    const types = events.map((e) => e.type as string);

    // Required event types are all present.
    expect(types).toContain("session");
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("text_delta");
    expect(types).toContain("finish");

    // First event is `session` with a non-empty session_id (from runHarness
    // onSession — the route does NOT emit session anymore on the streamed path).
    expect(events[0]?.type).toBe("session");
    expect(typeof events[0]?.session_id).toBe("string");
    expect((events[0]?.session_id as string).length).toBeGreaterThan(0);

    // tool_call carries the toolId we registered.
    const toolCallEvt = events.find((e) => e.type === "tool_call");
    expect(toolCallEvt?.toolId).toBe("search_knowledge");
    const toolResultEvt = events.find((e) => e.type === "tool_result");
    expect(toolResultEvt?.toolId).toBe("search_knowledge");

    // Last event is `finish` with a finishReason field.
    const last = events[events.length - 1];
    expect(last?.type).toBe("finish");
    expect(typeof last?.finishReason).toBe("string");

    // Strict ordering: session < tool_call < tool_result < first text_delta < finish.
    const idx = (t: string) => types.indexOf(t);
    expect(idx("session")).toBeLessThan(idx("tool_call"));
    expect(idx("tool_call")).toBeLessThan(idx("tool_result"));
    expect(idx("tool_result")).toBeLessThan(idx("text_delta"));
    expect(idx("text_delta")).toBeLessThan(types.lastIndexOf("finish"));
  });
});
