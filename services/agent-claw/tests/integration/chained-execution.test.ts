// Integration test: chained-execution loop runs a 3-step plan to completion
// against a real Postgres.
//
// Phase 8 of the harness control-plane rebuild plan, task 8.3. Drives
// `runChainedHarness` directly (exported for tests via routes/sessions.ts)
// rather than going through the full Fastify route — that keeps the
// per-test wiring minimal while still exercising every persistence call:
// loadSession → hydrateScratchpad → Budget → runHarness → saveSession in
// a loop, against the real schema with the etag-regen trigger live.
//
// What this asserts:
//   - 3 tool turns + a final text turn drive the chain to a clean "stop".
//   - agent_sessions.session_input_tokens accumulates across turns.
//   - agent_todos rows can be inserted up front and aren't disturbed.
//
// Skips when Docker isn't available so the suite stays green on developer
// machines without Docker.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Pool } from "pg";
import {
  startTestPostgres,
  stopTestPostgres,
  isDockerAvailable,
} from "../helpers/postgres-container.js";
import { runChainedHarness } from "../../src/routes/sessions.js";
import { lifecycle } from "../../src/core/runtime.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { defineTool } from "../../src/tools/tool.js";
import type { Config } from "../../src/config.js";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

const dockerAvailable = await isDockerAvailable();

// Minimal Config the chained-runner reads. Mirrors makeConfig() in
// chat-streaming-via-harness.test.ts — the schema has more fields, but
// strict mode lets unmentioned ones default to undefined since they aren't
// touched by runChainedHarness.
function makeConfig(): Config {
  return {
    AGENT_HOST: "127.0.0.1",
    AGENT_PORT: 3101,
    AGENT_LOG_LEVEL: "silent",
    AGENT_CORS_ORIGINS: "http://localhost:8501",
    AGENT_BODY_LIMIT_BYTES: 1_048_576,
    AGENT_RATE_LIMIT_MAX: 1000,
    AGENT_RATE_LIMIT_WINDOW_MS: 60_000,
    // Three steps + final text → 4 LLM calls. Cap at 5 to give headroom.
    AGENT_CHAT_MAX_STEPS: 5,
    AGENT_TOKEN_BUDGET: 100_000,
    AGENT_PLAN_MAX_AUTO_TURNS: 4,
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
  } as Config;
}

describe.skipIf(!dockerAvailable)(
  "chained-execution loop runs a 3-step plan to completion (integration)",
  () => {
    let pool: Pool;
    const userId = "chained-test-user@example.com";

    beforeAll(async () => {
      ({ pool } = await startTestPostgres(repoRoot));
      // Clear the global lifecycle so production hooks (loaded by other test
      // files) don't spuriously fire. runChainedHarness pulls `lifecycle`
      // from runtime.ts, so this is the right knob — same approach
      // chat-streaming-via-harness.test.ts uses.
      lifecycle.clear();
    }, 180_000);

    afterAll(async () => {
      lifecycle.clear();
      await stopTestPostgres();
    });

    it("runs 3 tool steps + final text → stop, persists cumulative tokens", async () => {
      // 1. Build a session row directly (skip createSession's RLS dance —
      //    we set app.current_user_entra_id explicitly via withUserContext
      //    inside the saves the harness does).
      const sessionInsert = await pool.query<{ id: string; etag: string }>(
        `INSERT INTO agent_sessions (user_entra_id)
         VALUES ($1)
         RETURNING id::text AS id, etag::text AS etag`,
        [userId],
      );
      const sessionId = sessionInsert.rows[0]!.id;

      // 2. Insert 3 todos (status='pending') so we can confirm the chained
      //    runner doesn't mangle them. (manage_todos isn't in the test
      //    registry, so the harness shouldn't touch them.)
      await pool.query(
        `INSERT INTO agent_todos (session_id, ordering, content, status)
         VALUES ($1::uuid, 1, 'step a', 'pending'),
                ($1::uuid, 2, 'step b', 'pending'),
                ($1::uuid, 3, 'step c', 'pending')`,
        [sessionId],
      );

      // 3. Three tools the LLM will pretend to call, plus a final text.
      const stepATool = defineTool({
        id: "step_a",
        description: "test step A",
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.literal(true) }),
        execute: async () => ({ ok: true as const }),
      });
      const stepBTool = defineTool({
        id: "step_b",
        description: "test step B",
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.literal(true) }),
        execute: async () => ({ ok: true as const }),
      });
      const stepCTool = defineTool({
        id: "step_c",
        description: "test step C",
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.literal(true) }),
        execute: async () => ({ ok: true as const }),
      });

      const registry = new ToolRegistry();
      registry.register(stepATool);
      registry.register(stepBTool);
      registry.register(stepCTool);

      // 4. Stub LLM: 3 tool_calls then a final text. All four happen in a
      //    SINGLE harness turn (the inner runHarness loop walks the queue
      //    until it sees a `kind: "text"` step). That means autoTurns=1 and
      //    finalFinishReason="stop" — exactly what the chain should report.
      const llm = new StubLlmProvider()
        .enqueueToolCall("step_a", {}, { promptTokens: 100, completionTokens: 20 })
        .enqueueToolCall("step_b", {}, { promptTokens: 100, completionTokens: 20 })
        .enqueueToolCall("step_c", {}, { promptTokens: 100, completionTokens: 20 })
        .enqueueText("done", { promptTokens: 100, completionTokens: 30 });

      // 5. Drive the chain.
      const result = await runChainedHarness({
        pool,
        user: userId,
        sessionId,
        messages: [{ role: "user", content: "do steps a, b, c" }],
        cfg: makeConfig(),
        llm,
        registry,
        log: { warn: () => {}, error: () => {} },
        // Plan progress: a 3-step plan that exactly matches our tools.
        planForProgress: {
          id: "plan-test",
          steps: [
            { tool: "step_a" },
            { tool: "step_b" },
            { tool: "step_c" },
          ],
          initialIndex: 0,
        },
      });

      // 6. Outcome assertions.
      expect(result.finalFinishReason).toBe("stop");
      expect(result.autoTurns).toBe(1); // single turn handled all three tools
      expect(result.totalSteps).toBe(4); // 3 tool steps + 1 text step
      expect(result.planFinalStepIndex).toBe(3);

      // 7. Cumulative usage persisted to agent_sessions.session_input_tokens.
      //    400 prompt tokens (4 calls × 100). The trigger regenerated etag too.
      const sessionAfter = await pool.query<{
        session_input_tokens: string;
        session_output_tokens: string;
        session_steps: number;
        last_finish_reason: string;
        message_count: number;
      }>(
        `SELECT session_input_tokens,
                session_output_tokens,
                session_steps,
                last_finish_reason,
                message_count
           FROM agent_sessions
          WHERE id = $1::uuid`,
        [sessionId],
      );
      const row = sessionAfter.rows[0]!;
      expect(Number(row.session_input_tokens)).toBe(400);
      // 20+20+20+30 = 90 output tokens.
      expect(Number(row.session_output_tokens)).toBe(90);
      expect(row.session_steps).toBe(4);
      expect(row.last_finish_reason).toBe("stop");
      // 1 user msg + 3 tool messages + 1 final assistant text = 5.
      expect(row.message_count).toBe(5);

      // 8. Todos untouched — chained runner doesn't mutate them.
      const todosAfter = await pool.query<{ status: string; ordering: number }>(
        `SELECT status, ordering FROM agent_todos
          WHERE session_id = $1::uuid
          ORDER BY ordering`,
        [sessionId],
      );
      expect(todosAfter.rows).toHaveLength(3);
      expect(todosAfter.rows.every((r) => r.status === "pending")).toBe(true);

    });
  },
);
