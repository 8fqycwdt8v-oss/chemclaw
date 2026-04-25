// Tests for POST /api/learn — skill induction endpoint (Phase C.3)

import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import type { Pool, QueryResult } from "pg";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { registerLearnRoute } from "../../src/routes/learn.js";

// ---------------------------------------------------------------------------
// Minimal stub pool
// ---------------------------------------------------------------------------

function makePool(
  insertFn: (sql: string, params: unknown[]) => { rows: Array<{ id: string; name: string }> },
): Pool {
  return {
    query: async <T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
      // withUserContext uses a transaction client — we need to handle SET LOCAL too.
      const result = insertFn(sql, params ?? []);
      return {
        rows: result.rows as unknown as T[],
        rowCount: result.rows.length,
        command: "INSERT",
        oid: 0,
        fields: [],
      };
    },
    connect: async () => ({
      query: async <T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
        const result = insertFn(sql, params ?? []);
        return {
          rows: result.rows as unknown as T[],
          rowCount: result.rows.length,
          command: "SELECT",
          oid: 0,
          fields: [],
        };
      },
      release: () => {},
    }),
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Route tests
// ---------------------------------------------------------------------------

async function buildApp(llm?: StubLlmProvider) {
  const app = Fastify({ logger: false });
  const provider = llm ?? new StubLlmProvider();

  // Intercept withUserContext — it calls pool.connect() then client.query().
  const insertedRows: Array<{ name: string; prompt_md: string }> = [];
  const pool: Pool = {
    connect: async () => {
      const client = {
        query: async <T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
          if (sql.startsWith("SET LOCAL")) {
            return { rows: [], rowCount: 0, command: "SET", oid: 0, fields: [] } as QueryResult<T>;
          }
          if (sql.startsWith("BEGIN")) {
            return { rows: [], rowCount: 0, command: "BEGIN", oid: 0, fields: [] } as QueryResult<T>;
          }
          if (sql.startsWith("COMMIT")) {
            return { rows: [], rowCount: 0, command: "COMMIT", oid: 0, fields: [] } as QueryResult<T>;
          }
          if (sql.includes("INSERT INTO skill_library")) {
            const name = (params?.[0] as string) ?? "unnamed";
            const promptMd = (params?.[1] as string) ?? "";
            insertedRows.push({ name, prompt_md: promptMd });
            return {
              rows: [{ id: "test-uuid-1", name }] as unknown as T[],
              rowCount: 1,
              command: "INSERT",
              oid: 0,
              fields: [],
            };
          }
          return { rows: [] as unknown as T[], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
        },
        release: () => {},
      };
      return client;
    },
  } as unknown as Pool;

  registerLearnRoute(app, {
    pool,
    llm: provider,
    getUser: () => "test@example.com",
  });

  return { app, insertedRows };
}

describe("POST /api/learn", () => {
  it("returns 400 for missing title", async () => {
    const { app } = await buildApp();
    const resp = await app.inject({
      method: "POST",
      url: "/api/learn",
      body: { last_turn_text: "Some agent turn text here." },
    });
    expect(resp.statusCode).toBe(400);
  });

  it("returns 400 for missing last_turn_text", async () => {
    const { app } = await buildApp();
    const resp = await app.inject({
      method: "POST",
      url: "/api/learn",
      body: { title: "My Skill" },
    });
    expect(resp.statusCode).toBe(400);
  });

  it("returns 200 and a skill_id for valid input", async () => {
    const llm = new StubLlmProvider();
    llm.enqueueJson({ prompt_md: "## My Skill\n\nUse tool X, then Y." });

    const { app } = await buildApp(llm);
    const resp = await app.inject({
      method: "POST",
      url: "/api/learn",
      body: {
        title: "My Skill",
        last_turn_text: "The agent called canonicalize_smiles then propose_hypothesis.",
        source_trace_id: "trace-abc-123",
      },
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.ok).toBe(true);
    expect(typeof body.skill_id).toBe("string");
    expect(body.name).toBe("my_skill");
    expect(typeof body.shadow_until).toBe("string");
  });

  it("sanitizes the skill name correctly", async () => {
    const llm = new StubLlmProvider();
    llm.enqueueJson({ prompt_md: "## Weird Name Skill\n\nBody." });

    const { app, insertedRows } = await buildApp(llm);
    await app.inject({
      method: "POST",
      url: "/api/learn",
      body: {
        title: "Weird Name & Skill!",
        last_turn_text: "Agent turn content with enough text to pass validation.",
      },
    });
    // Name should be lowercased and have spaces replaced with underscores.
    expect(insertedRows[0]?.name).toMatch(/^weird_name.*skill/);
  });
});
