// Tests for POST /api/chat/plan/approve and POST /api/chat/plan/reject.

import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerPlanRoutes } from "../../src/routes/plan.js";
import { planStore, createPlan } from "../../src/core/plan-mode.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { PlanRouteDeps } from "../../src/routes/plan.js";
import type { Pool } from "pg";
import { vi } from "vitest";

// Minimal config for plan route deps.
const stubConfig = {
  AGENT_CHAT_MAX_STEPS: 10,
  AGENT_TOKEN_BUDGET: 50_000,
  AGENT_CHAT_RATE_LIMIT_MAX: 30,
  AGENT_CHAT_RATE_LIMIT_WINDOW_MS: 60_000,
  AGENT_CHAT_MAX_HISTORY: 40,
  AGENT_CHAT_MAX_INPUT_CHARS: 40_000,
  AGENT_CORS_ORIGINS: "",
  MCP_DOC_FETCHER_URL: "http://localhost:8006",
} as unknown as import("../../src/config.js").Config;

// Minimal pool stub.
const stubPool = {} as Pool;

async function buildApp(llm: StubLlmProvider) {
  const app = Fastify({ logger: false });
  const registry = new ToolRegistry();

  const promptRegistry = {
    getActive: vi.fn().mockRejectedValue(new Error("not seeded")),
  } as unknown as import("../../src/prompts/registry.js").PromptRegistry;

  const deps: PlanRouteDeps = {
    config: stubConfig,
    pool: stubPool,
    llm,
    registry,
    promptRegistry,
    getUser: () => "test@example.com",
  };

  registerPlanRoutes(app, deps);
  await app.ready();
  return await app;
}

describe("POST /api/chat/plan/reject", () => {
  it("rejects a saved plan and returns ok", async () => {
    const plan = createPlan(
      [{ step_number: 1, tool: "search_knowledge", args: {}, rationale: "find" }],
      [{ role: "user", content: "test" }],
      "test@example.com",
    );
    planStore.save(plan);

    const llm = new StubLlmProvider();
    const app = await buildApp(llm);

    const resp = await app.inject({
      method: "POST",
      url: "/api/chat/plan/reject",
      payload: JSON.stringify({ plan_id: plan.plan_id }),
      headers: { "content-type": "application/json" },
    });

    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.ok).toBe(true);
    // Plan should be gone from the store.
    expect(planStore.get(plan.plan_id)).toBeUndefined();
    await app.close();
  });

  it("returns 404 when rejecting a non-existent plan", async () => {
    const llm = new StubLlmProvider();
    const app = await buildApp(llm);

    const resp = await app.inject({
      method: "POST",
      url: "/api/chat/plan/reject",
      payload: JSON.stringify({ plan_id: "00000000-0000-0000-0000-000000000000" }),
      headers: { "content-type": "application/json" },
    });
    expect(resp.statusCode).toBe(404);
    await app.close();
  });

  it("returns 400 for invalid plan_id format", async () => {
    const llm = new StubLlmProvider();
    const app = await buildApp(llm);

    const resp = await app.inject({
      method: "POST",
      url: "/api/chat/plan/reject",
      payload: JSON.stringify({ plan_id: "not-a-uuid" }),
      headers: { "content-type": "application/json" },
    });
    expect(resp.statusCode).toBe(400);
    await app.close();
  });
});

describe("POST /api/chat/plan/approve", () => {
  it("returns 404 when approving a non-existent plan", async () => {
    const llm = new StubLlmProvider();
    const app = await buildApp(llm);

    const resp = await app.inject({
      method: "POST",
      url: "/api/chat/plan/approve",
      payload: JSON.stringify({ plan_id: "00000000-0000-0000-0000-000000000001" }),
      headers: { "content-type": "application/json" },
    });
    expect(resp.statusCode).toBe(404);
    await app.close();
  });

  it("returns 400 for invalid plan_id format", async () => {
    const llm = new StubLlmProvider();
    const app = await buildApp(llm);

    const resp = await app.inject({
      method: "POST",
      url: "/api/chat/plan/approve",
      payload: JSON.stringify({ plan_id: "bad-id" }),
      headers: { "content-type": "application/json" },
    });
    expect(resp.statusCode).toBe(400);
    await app.close();
  });

  it("removes plan from store on approve (SSE path initiated)", async () => {
    const plan = createPlan(
      [{ step_number: 1, tool: "canonicalize_smiles", args: { smiles: "CCO" }, rationale: "normalize" }],
      [{ role: "system", content: "sys" }, { role: "user", content: "do it" }],
      "test@example.com",
    );
    planStore.save(plan);
    expect(planStore.get(plan.plan_id)).toBeTruthy();

    const llm = new StubLlmProvider();
    llm.enqueueText("Done executing.");
    const app = await buildApp(llm);

    // The approve endpoint streams SSE — we just check it doesn't crash + plan is removed.
    const resp = await app.inject({
      method: "POST",
      url: "/api/chat/plan/approve",
      payload: JSON.stringify({ plan_id: plan.plan_id }),
      headers: { "content-type": "application/json" },
    });

    // Plan removed from store.
    expect(planStore.get(plan.plan_id)).toBeUndefined();
    // The response is SSE (content-type: text/event-stream) and 200.
    expect(resp.statusCode).toBe(200);
    await app.close();
  });
});
