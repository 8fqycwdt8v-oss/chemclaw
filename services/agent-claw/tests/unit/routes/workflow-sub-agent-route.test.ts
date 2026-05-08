// Tests for /api/internal/workflows/sub_agent — JWT-authenticated entry
// point that the workflow_engine's sub_agent step calls into.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Config } from "../../../src/config.js";
import type { LlmProvider } from "../../../src/llm/provider.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import { signMcpToken } from "../../../src/security/mcp-tokens.js";
import { registerWorkflowSubAgentRoute } from "../../../src/routes/workflow-sub-agent.js";
import * as subAgentModule from "../../../src/core/sub-agent.js";

const SIGNING_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef";

beforeAll(() => {
  process.env.MCP_AUTH_SIGNING_KEY = SIGNING_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerWorkflowSubAgentRoute(app, {
    pool: {} as unknown as Pool,
    config: { AGENT_MODEL: "fake" } as unknown as Config,
    llm: {} as unknown as LlmProvider,
    registry: new ToolRegistry(),
  });
  return app;
}

function token(opts: {
  user: string;
  scope?: string;
  audience?: string;
}): string {
  return signMcpToken({
    sandboxId: "workflow-engine",
    userEntraId: opts.user,
    scopes: [opts.scope ?? "agent:sub_agent"],
    audience: opts.audience ?? "agent-claw",
    signingKey: SIGNING_KEY,
  });
}

describe("/api/internal/workflows/sub_agent", () => {
  it("rejects requests without a Bearer token (401)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/workflows/sub_agent",
      payload: { goal: "x", user_entra_id: "u" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "unauthenticated" });
  });

  it("rejects tokens with the wrong scope (401)", async () => {
    const app = buildApp();
    const t = token({ user: "u1", scope: "agent:resume" });
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/workflows/sub_agent",
      headers: { authorization: `Bearer ${t}` },
      payload: { goal: "x", user_entra_id: "u1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects tokens with the wrong audience (401)", async () => {
    const app = buildApp();
    const t = token({ user: "u1", audience: "mcp-rdkit" });
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/workflows/sub_agent",
      headers: { authorization: `Bearer ${t}` },
      payload: { goal: "x", user_entra_id: "u1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects when body.user_entra_id differs from claims.user (403)", async () => {
    const app = buildApp();
    const t = token({ user: "claimant" });
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/workflows/sub_agent",
      headers: { authorization: `Bearer ${t}` },
      payload: { goal: "x", user_entra_id: "spoofed" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "user_mismatch" });
  });

  it("rejects malformed body (400)", async () => {
    const app = buildApp();
    const t = token({ user: "u1" });
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/workflows/sub_agent",
      headers: { authorization: `Bearer ${t}` },
      payload: { goal: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("invokes spawnSubAgent and returns the snake-cased result on success", async () => {
    const app = buildApp();
    const spawnSpy = vi
      .spyOn(subAgentModule, "spawnSubAgent")
      .mockResolvedValue({
        text: "done",
        finishReason: "stop",
        citations: ["fact-1", "fact-2"],
        stepsUsed: 3,
        usage: {
          stepsUsed: 3,
          stepsRemaining: 7,
          maxSteps: 10,
          promptTokensUsed: 100,
          promptTokensRemaining: 0,
          maxPromptTokens: 100,
          completionTokensUsed: 50,
          completionTokensRemaining: 0,
          maxCompletionTokens: 50,
          thoughtTokensUsed: 0,
          thoughtTokensRemaining: 0,
          maxThoughtTokens: 0,
        },
      });

    const t = token({ user: "u-real" });
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/workflows/sub_agent",
      headers: { authorization: `Bearer ${t}` },
      payload: {
        goal: "find similar reactions",
        user_entra_id: "u-real",
        type: "chemist",
        max_steps: 5,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      text: "done",
      finish_reason: "stop",
      citations: ["fact-1", "fact-2"],
      steps_used: 3,
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [spawnedType, taskSpec, parentCtx] = spawnSpy.mock.calls[0];
    expect(spawnedType).toBe("chemist");
    expect(taskSpec).toMatchObject({ goal: "find similar reactions", max_steps: 5 });
    expect(parentCtx.userEntraId).toBe("u-real");
  });

  it("returns 500 when spawnSubAgent throws", async () => {
    const app = buildApp();
    vi.spyOn(subAgentModule, "spawnSubAgent").mockRejectedValue(
      new Error("budget exceeded"),
    );

    const t = token({ user: "u1" });
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/workflows/sub_agent",
      headers: { authorization: `Bearer ${t}` },
      payload: { goal: "x", user_entra_id: "u1" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: "sub_agent_failed" });
  });
});
