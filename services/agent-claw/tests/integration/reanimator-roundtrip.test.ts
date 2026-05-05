// Integration test: reanimator → /api/internal/sessions/:id/resume round-trip.
//
// Phase 8 of the harness control-plane rebuild plan, task 8.4. Three asserts
// against a real Postgres:
//
//   (a) The reanimator's selection SQL (lifted verbatim from
//       services/optimizer/session_reanimator/main.py) returns a stalled
//       session and ignores ones that don't qualify.
//   (b) tryIncrementAutoResumeCount is atomic: it bumps the counter once,
//       refuses past the cap, and refuses when the session is paused on a
//       clarifying question.
//   (c) The /api/internal/sessions/:id/resume route accepts a JWT signed
//       with the right scope, rejects an unsigned request, and rejects the
//       wrong scope. (The harness body is stubbed via an LLM that returns
//       a one-step "stop" so the test stays under a second.)
//
// Skips when Docker isn't available so developer machines without Docker
// stay green.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  startTestPostgres,
  stopTestPostgres,
  isDockerAvailable,
} from "../helpers/postgres-container.js";
import { tryIncrementAutoResumeCount } from "../../src/core/session-store.js";
import { registerSessionsRoute } from "../../src/routes/sessions.js";
import { signMcpToken } from "../../src/security/mcp-tokens.js";
import { lifecycle } from "../../src/core/runtime.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Config } from "../../src/config.js";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

const dockerAvailable = await isDockerAvailable();

// Reanimator selection query, copied from services/optimizer/session_reanimator/
// main.py:_FIND_RESUMABLE_SQL with %s placeholders rewritten as $1 / $2 for
// pg's parameterised binding. If the Python query changes, this test needs
// to track — that's the point: a divergence is exactly what we want to catch.
const FIND_RESUMABLE_SQL = `
SELECT s.id::text AS id,
       s.user_entra_id,
       s.last_finish_reason,
       s.auto_resume_count,
       s.auto_resume_cap,
       s.session_input_tokens,
       COALESCE(s.session_token_budget, 1000000) AS session_token_budget
  FROM agent_sessions s
 WHERE s.last_finish_reason IN ('max_steps', 'stop')
   AND s.auto_resume_count < s.auto_resume_cap
   AND s.session_input_tokens < COALESCE(s.session_token_budget, 1000000)
   AND s.updated_at < NOW() - make_interval(secs => $1)
   AND EXISTS (
     SELECT 1 FROM agent_todos t
      WHERE t.session_id = s.id
        AND t.status = 'in_progress'
   )
 ORDER BY s.updated_at ASC
 LIMIT $2
`;

// Strong-enough HS256 key for sign + verify (>=32 chars per mcp-tokens.ts).
const TEST_SIGNING_KEY = "test-signing-key-aaaabbbbccccddddeeeeffffgggghhhh";

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
    AGENT_PLAN_MAX_AUTO_TURNS: 1,
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
  "session reanimator round-trip (integration)",
  () => {
    let pool: Pool;
    const userId = "reanimator-test-user@example.com";

    beforeAll(async () => {
      ({ pool } = await startTestPostgres(repoRoot));
      lifecycle.clear();
    }, 180_000);

    afterAll(async () => {
      lifecycle.clear();
      await stopTestPostgres();
    });

    // -----------------------------------------------------------------------
    // (a) The reanimator's selection query.
    // -----------------------------------------------------------------------
    it("reanimator selection query returns stalled sessions and skips others", async () => {
      // Stalled session: stop, count<cap, has in_progress todo, old updated_at.
      const stalled = await pool.query<{ id: string }>(
        `INSERT INTO agent_sessions (user_entra_id, last_finish_reason, updated_at)
         VALUES ($1, 'max_steps', NOW() - INTERVAL '10 minutes')
         RETURNING id::text AS id`,
        [userId],
      );
      const stalledId = stalled.rows[0]!.id;
      await pool.query(
        `INSERT INTO agent_todos (session_id, ordering, content, status)
         VALUES ($1::uuid, 1, 'still working', 'in_progress')`,
        [stalledId],
      );

      // Skip 1: awaiting_user_input — not eligible.
      const awaiting = await pool.query<{ id: string }>(
        `INSERT INTO agent_sessions (user_entra_id, last_finish_reason, updated_at)
         VALUES ($1, 'awaiting_user_input', NOW() - INTERVAL '10 minutes')
         RETURNING id::text AS id`,
        [userId],
      );
      await pool.query(
        `INSERT INTO agent_todos (session_id, ordering, content, status)
         VALUES ($1::uuid, 1, 'paused', 'in_progress')`,
        [awaiting.rows[0]!.id],
      );

      // Skip 2: cap reached.
      const capped = await pool.query<{ id: string }>(
        `INSERT INTO agent_sessions (user_entra_id, last_finish_reason,
                                      auto_resume_count, auto_resume_cap,
                                      updated_at)
         VALUES ($1, 'max_steps', 10, 10, NOW() - INTERVAL '10 minutes')
         RETURNING id::text AS id`,
        [userId],
      );
      await pool.query(
        `INSERT INTO agent_todos (session_id, ordering, content, status)
         VALUES ($1::uuid, 1, 'capped', 'in_progress')`,
        [capped.rows[0]!.id],
      );

      // Skip 3: no in_progress todo.
      const noTodo = await pool.query<{ id: string }>(
        `INSERT INTO agent_sessions (user_entra_id, last_finish_reason, updated_at)
         VALUES ($1, 'stop', NOW() - INTERVAL '10 minutes')
         RETURNING id::text AS id`,
        [userId],
      );
      await pool.query(
        `INSERT INTO agent_todos (session_id, ordering, content, status)
         VALUES ($1::uuid, 1, 'done', 'completed')`,
        [noTodo.rows[0]!.id],
      );

      // Skip 4: too fresh (updated_at is NOW()).
      const fresh = await pool.query<{ id: string }>(
        `INSERT INTO agent_sessions (user_entra_id, last_finish_reason)
         VALUES ($1, 'max_steps')
         RETURNING id::text AS id`,
        [userId],
      );
      await pool.query(
        `INSERT INTO agent_todos (session_id, ordering, content, status)
         VALUES ($1::uuid, 1, 'fresh', 'in_progress')`,
        [fresh.rows[0]!.id],
      );

      const r = await pool.query<{ id: string }>(FIND_RESUMABLE_SQL, [300, 100]);
      const ids = r.rows.map((row) => row.id);
      expect(ids).toContain(stalledId);
      expect(ids).not.toContain(awaiting.rows[0]!.id);
      expect(ids).not.toContain(capped.rows[0]!.id);
      expect(ids).not.toContain(noTodo.rows[0]!.id);
      expect(ids).not.toContain(fresh.rows[0]!.id);
    });

    // -----------------------------------------------------------------------
    // (b) tryIncrementAutoResumeCount atomicity.
    // -----------------------------------------------------------------------
    it("tryIncrementAutoResumeCount: bumps once, then refuses past cap", async () => {
      const ins = await pool.query<{ id: string }>(
        `INSERT INTO agent_sessions (user_entra_id, last_finish_reason,
                                      auto_resume_count, auto_resume_cap)
         VALUES ($1, 'max_steps', 0, 2)
         RETURNING id::text AS id`,
        [userId],
      );
      const sid = ins.rows[0]!.id;

      const c1 = await tryIncrementAutoResumeCount(pool, userId, sid);
      const c2 = await tryIncrementAutoResumeCount(pool, userId, sid);
      const c3 = await tryIncrementAutoResumeCount(pool, userId, sid);
      expect(c1).toBe(1);
      expect(c2).toBe(2);
      expect(c3).toBeNull(); // cap was 2; third call refused
    });

    it("tryIncrementAutoResumeCount: refuses when awaiting_user_input", async () => {
      const ins = await pool.query<{ id: string }>(
        `INSERT INTO agent_sessions (user_entra_id, last_finish_reason)
         VALUES ($1, 'awaiting_user_input')
         RETURNING id::text AS id`,
        [userId],
      );
      const sid = ins.rows[0]!.id;
      const c = await tryIncrementAutoResumeCount(pool, userId, sid);
      expect(c).toBeNull();
    });

    // -----------------------------------------------------------------------
    // (c) /api/internal/sessions/:id/resume JWT validation.
    //
    // We register the sessions route on a fresh Fastify instance and use
    // app.inject() — same pattern as chat-streaming-via-harness.test.ts.
    // The route will atomically increment auto_resume_count then call
    // runChainedHarness, which we keep cheap by giving it a one-shot text
    // LLM (no tools).
    // -----------------------------------------------------------------------
    describe("internal resume endpoint", () => {
      let app: FastifyInstance;
      const previousKey = process.env.MCP_AUTH_SIGNING_KEY;

      beforeAll(async () => {
        process.env.MCP_AUTH_SIGNING_KEY = TEST_SIGNING_KEY;
        app = Fastify({ logger: false });
        const llm = new StubLlmProvider();
        // Each request consumes one queued response. Pre-stage a generous
        // pool of "stop" texts so test ordering doesn't matter.
        for (let i = 0; i < 8; i++) {
          llm.enqueueText("done", { promptTokens: 5, completionTokens: 5 });
        }
        const registry = new ToolRegistry();
        registerSessionsRoute(app, {
          pool,
          // The internal route takes the user from the JWT, so getUser is
          // only used by the public endpoints — give it a default.
          getUser: () => userId,
          config: makeConfig(),
          llm,
          registry,
        });
        await app.ready();
      });

      afterAll(async () => {
        await app.close();
        if (previousKey === undefined) {
          delete process.env.MCP_AUTH_SIGNING_KEY;
        } else {
          process.env.MCP_AUTH_SIGNING_KEY = previousKey;
        }
      });

      it("rejects requests without an Authorization header (401)", async () => {
        // We need a real session id so the route doesn't 400 on UUID parsing.
        const ins = await pool.query<{ id: string }>(
          `INSERT INTO agent_sessions (user_entra_id, last_finish_reason)
           VALUES ($1, 'max_steps') RETURNING id::text AS id`,
          [userId],
        );
        const sid = ins.rows[0]!.id;

        const res = await app.inject({
          method: "POST",
          url: `/api/internal/sessions/${sid}/resume`,
        });
        expect(res.statusCode).toBe(401);
      });

      it("rejects a token with the wrong scope (401)", async () => {
        const ins = await pool.query<{ id: string }>(
          `INSERT INTO agent_sessions (user_entra_id, last_finish_reason)
           VALUES ($1, 'max_steps') RETURNING id::text AS id`,
          [userId],
        );
        const sid = ins.rows[0]!.id;

        const wrongScopeToken = signMcpToken({
          sandboxId: "reanimator",
          userEntraId: userId,
          // Not "agent:resume" — should bounce.
          scopes: ["mcp_kg:read"],
          audience: "agent-claw",
          signingKey: TEST_SIGNING_KEY,
        });

        const res = await app.inject({
          method: "POST",
          url: `/api/internal/sessions/${sid}/resume`,
          headers: { authorization: `Bearer ${wrongScopeToken}` },
        });
        expect(res.statusCode).toBe(401);
      });

      it("accepts a valid agent:resume token and runs a turn", async () => {
        const ins = await pool.query<{ id: string }>(
          `INSERT INTO agent_sessions (user_entra_id, last_finish_reason)
           VALUES ($1, 'max_steps') RETURNING id::text AS id`,
          [userId],
        );
        const sid = ins.rows[0]!.id;

        const token = signMcpToken({
          sandboxId: "reanimator",
          userEntraId: userId,
          scopes: ["agent:resume"],
          audience: "agent-claw",
          signingKey: TEST_SIGNING_KEY,
        });

        const res = await app.inject({
          method: "POST",
          url: `/api/internal/sessions/${sid}/resume`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.session_id).toBe(sid);
        expect(body.final_finish_reason).toBe("stop");
        expect(body.auto_resume_count).toBe(1);

        // The route trusts ONLY the JWT-claimed user. Verify by reading the
        // row back: auto_resume_count was bumped under userId scope.
        const after = await pool.query<{ auto_resume_count: number }>(
          `SELECT auto_resume_count FROM agent_sessions WHERE id = $1::uuid`,
          [sid],
        );
        expect(after.rows[0]!.auto_resume_count).toBe(1);
      });
    });
  },
);
