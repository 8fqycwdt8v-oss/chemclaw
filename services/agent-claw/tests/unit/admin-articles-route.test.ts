// Tests for POST /api/admin/articles/:id/maturity (ADR 012 Phase 4b-i).

import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import type { Pool, QueryResult } from "pg";
import { registerAdminRoutes } from "../../src/routes/admin/index.js";
import {
  ConfigRegistry,
  setConfigRegistry,
} from "../../src/config/registry.js";
import {
  FeatureFlagRegistry,
  setFeatureFlagRegistry,
} from "../../src/config/flags.js";

interface ArticleStub {
  id: string;
  slug: string;
  kind: string;
  maturity: string;
  revision: number;
  etag: number;
}

interface MockState {
  isAdminResult: boolean;
  articles: ArticleStub[];
  updates: Array<{ id: string; maturity: string }>;
  auditInserts: Array<{ actor: string; action: string; target: string; before: unknown; after: unknown }>;
}

function makePool(state: MockState): Pool {
  return {
    connect: async () => ({
      query: async <T = unknown>(
        sql: string,
        params?: unknown[],
      ): Promise<QueryResult<T>> => {
        if (
          sql.startsWith("BEGIN") ||
          sql.startsWith("COMMIT") ||
          sql.startsWith("ROLLBACK") ||
          sql.startsWith("SELECT set_config")
        ) {
          return { rows: [] as T[], rowCount: 0, command: "SET", oid: 0, fields: [] };
        }
        if (sql.includes("current_user_is_admin")) {
          return {
            rows: [{ is_admin: state.isAdminResult }] as unknown as T[],
            rowCount: 1,
            command: "SELECT",
            oid: 0,
            fields: [],
          };
        }
        if (sql.includes("FROM knowledge_articles")) {
          const id = params?.[0] as string;
          const found = state.articles.find((a) => a.id === id) ?? null;
          return {
            rows: found ? ([found] as unknown as T[]) : [],
            rowCount: found ? 1 : 0,
            command: "SELECT",
            oid: 0,
            fields: [],
          };
        }
        if (sql.includes("UPDATE knowledge_articles")) {
          const id = params?.[0] as string;
          const tier = params?.[1] as string;
          const found = state.articles.find((a) => a.id === id) ?? null;
          if (!found) {
            return { rows: [] as T[], rowCount: 0, command: "UPDATE", oid: 0, fields: [] };
          }
          found.maturity = tier;
          found.etag += 1;
          state.updates.push({ id, maturity: tier });
          return {
            rows: [found] as unknown as T[],
            rowCount: 1,
            command: "UPDATE",
            oid: 0,
            fields: [],
          };
        }
        if (sql.includes("INSERT INTO admin_audit_log")) {
          state.auditInserts.push({
            actor: params?.[0] as string,
            action: params?.[1] as string,
            target: params?.[2] as string,
            before: params?.[3],
            after: params?.[4],
          });
          return {
            rows: [{ id: `a${state.auditInserts.length}` }] as unknown as T[],
            rowCount: 1,
            command: "INSERT",
            oid: 0,
            fields: [],
          };
        }
        return { rows: [] as T[], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
      },
      release: () => {},
    }),
  } as unknown as Pool;
}

function makeState(overrides: Partial<MockState> = {}): MockState {
  return {
    isAdminResult: true,
    articles: [],
    updates: [],
    auditInserts: [],
    ...overrides,
  };
}

async function buildApp(state: MockState, callerId = "admin@example.com") {
  const app = Fastify({ logger: false });
  const pool = makePool(state);
  setConfigRegistry(new ConfigRegistry(pool, 60_000));
  setFeatureFlagRegistry(new FeatureFlagRegistry(pool, 60_000));
  registerAdminRoutes(app, pool, () => callerId);
  return await app;
}

const ARTICLE_ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  delete process.env.AGENT_ADMIN_USERS;
});

describe("POST /api/admin/articles/:id/maturity", () => {
  it("403 when caller is not an admin", async () => {
    const state = makeState({ isAdminResult: false });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "POST",
      url: `/api/admin/articles/${ARTICLE_ID}/maturity`,
      payload: { tier: "WORKING" },
    });
    expect(resp.statusCode).toBe(403);
    expect(state.updates).toHaveLength(0);
  });

  it("400 when id is not a UUID", async () => {
    const state = makeState();
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "POST",
      url: "/api/admin/articles/not-a-uuid/maturity",
      payload: { tier: "WORKING" },
    });
    expect(resp.statusCode).toBe(400);
  });

  it("400 when tier is invalid", async () => {
    const state = makeState();
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "POST",
      url: `/api/admin/articles/${ARTICLE_ID}/maturity`,
      payload: { tier: "BOGUS" },
    });
    expect(resp.statusCode).toBe(400);
  });

  it("404 when the article doesn't exist", async () => {
    const state = makeState({ articles: [] });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "POST",
      url: `/api/admin/articles/${ARTICLE_ID}/maturity`,
      payload: { tier: "WORKING" },
    });
    expect(resp.statusCode).toBe(404);
    expect(state.auditInserts).toHaveLength(0);
  });

  it("promotes EXPLORATORY → WORKING, audits, bumps etag, leaves revision", async () => {
    const state = makeState({
      articles: [
        {
          id: ARTICLE_ID,
          slug: "compound/abc",
          kind: "compound",
          maturity: "EXPLORATORY",
          revision: 4,
          etag: 7,
        },
      ],
    });
    const app = await buildApp(state, "boss@x.com");
    const resp = await app.inject({
      method: "POST",
      url: `/api/admin/articles/${ARTICLE_ID}/maturity`,
      payload: { tier: "WORKING", reason: "two independent sources cited" },
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.maturity).toBe("WORKING");
    expect(body.etag).toBe(8);
    expect(body.changed).toBe(true);
    expect(state.updates).toEqual([{ id: ARTICLE_ID, maturity: "WORKING" }]);
    expect(state.auditInserts).toHaveLength(1);
    expect(state.auditInserts[0]).toMatchObject({
      actor: "boss@x.com",
      action: "knowledge_article.maturity",
      target: "compound/abc",
    });
    // before/after are JSON-stringified by appendAudit before insert.
    expect(JSON.parse(state.auditInserts[0].before as string)).toEqual({ maturity: "EXPLORATORY" });
    expect(JSON.parse(state.auditInserts[0].after as string)).toEqual({ maturity: "WORKING" });
  });

  it("noop when tier already matches; no audit row written", async () => {
    const state = makeState({
      articles: [
        {
          id: ARTICLE_ID,
          slug: "compound/abc",
          kind: "compound",
          maturity: "WORKING",
          revision: 4,
          etag: 7,
        },
      ],
    });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "POST",
      url: `/api/admin/articles/${ARTICLE_ID}/maturity`,
      payload: { tier: "WORKING" },
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.changed).toBe(false);
    expect(body.maturity).toBe("WORKING");
    expect(state.updates).toHaveLength(0);
    expect(state.auditInserts).toHaveLength(0);
  });

  it("supports demotion (FOUNDATION → EXPLORATORY)", async () => {
    const state = makeState({
      articles: [
        {
          id: ARTICLE_ID,
          slug: "compound/abc",
          kind: "compound",
          maturity: "FOUNDATION",
          revision: 4,
          etag: 7,
        },
      ],
    });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "POST",
      url: `/api/admin/articles/${ARTICLE_ID}/maturity`,
      payload: { tier: "EXPLORATORY", reason: "contradicting study landed" },
    });
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body).maturity).toBe("EXPLORATORY");
    expect(state.auditInserts).toHaveLength(1);
  });
});
