// Tests for the /api/articles routes (ADR 012 Phase 1). Fastify inject +
// mock pool; mirrors artifacts-route.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import type { Pool, PoolClient, QueryResult } from "pg";

import { registerKnowledgeArticlesRoutes } from "../../src/routes/knowledge-articles.js";
import { setFeatureFlagRegistry } from "../../src/config/flags.js";
import type { FeatureFlagRegistry } from "../../src/config/flags.js";

interface MockData {
  listRows?: Record<string, unknown>[];
  getRow?: Record<string, unknown> | null;
  patchRow?: Record<string, unknown> | null;
  existsRow?: Record<string, unknown> | null;
}

function makePool(data: MockData): Pool {
  const respond = (sql: string): unknown[] => {
    if (sql.includes('ORDER BY ka.updated_at')) return data.listRows ?? [];
    if (/FROM knowledge_articles ka\s+WHERE ka\.id/.test(sql)) return data.getRow ? [data.getRow] : [];
    if (/FROM knowledge_articles\s+WHERE id =/.test(sql)) return data.existsRow ? [data.existsRow] : [];
    if (sql.includes('UPDATE knowledge_articles SET')) return data.patchRow ? [data.patchRow] : [];
    if (/FROM knowledge_article_revisions\s+WHERE article_id/.test(sql)) return [{ title: "t", summary: null, body_md: "b" }];
    return []; // BEGIN / set_config / COMMIT / citation reads / inserts
  };
  const client: Partial<PoolClient> = {
    query: async (textOrConfig: unknown): Promise<QueryResult> => {
      const text = typeof textOrConfig === "string" ? textOrConfig : (textOrConfig as { text: string }).text;
      const rows = respond(text);
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    },
    release: () => {},
  };
  return { connect: async () => client as PoolClient } as unknown as Pool;
}

function buildApp(data: MockData) {
  const app = Fastify({ logger: false });
  registerKnowledgeArticlesRoutes(app, { pool: makePool(data), getUser: () => "scientist@pharma.com" });
  return app;
}

const ARTICLE_ID = "11111111-1111-1111-1111-111111111111";

function fullArticleRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ARTICLE_ID,
    slug: "topic/buchwald-hartwig-amination",
    kind: "topic",
    title: "Buchwald–Hartwig amination",
    summary: "Pd-catalysed C–N coupling.",
    body_md: "Body. [fact:22222222-2222-2222-2222-222222222222]",
    entity_ref: null,
    nce_project_id: null,
    group_id: "__system__",
    maturity: "EXPLORATORY",
    confidence_score: null,
    status: "current",
    dirty: false,
    dirty_reason: null,
    has_human_edits: false,
    source_count: 1,
    revision: 2,
    etag: 3,
    created_by: "scientist@pharma.com",
    last_edited_by: "scientist@pharma.com",
    created_at: "2026-05-12T00:00:00.000+00",
    updated_at: "2026-05-12T01:00:00.000+00",
    ...over,
  };
}

function summaryRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ARTICLE_ID,
    slug: "topic/x",
    kind: "topic",
    title: "X",
    summary: null,
    maturity: "EXPLORATORY",
    confidence_score: null,
    status: "current",
    dirty: false,
    has_human_edits: false,
    source_count: 0,
    revision: 1,
    etag: 1,
    updated_at: "2026-05-12T00:00:00.000+00",
    created_at: "2026-05-12T00:00:00.000+00",
    ...over,
  };
}

function setFlag(enabled: boolean): void {
  setFeatureFlagRegistry({ isEnabled: async () => enabled } as unknown as FeatureFlagRegistry);
}

beforeEach(() => setFlag(true));

describe("GET /api/articles", () => {
  it("404s when the wiki feature flag is off", async () => {
    setFlag(false);
    const resp = await buildApp({}).inject({ method: "GET", url: "/api/articles" });
    expect(resp.statusCode).toBe(404);
    expect(resp.json()).toMatchObject({ error: "feature_disabled" });
  });

  it("returns the article summaries", async () => {
    const resp = await buildApp({ listRows: [summaryRow(), summaryRow({ id: "33333333-3333-3333-3333-333333333333", slug: "glossary", kind: "glossary" })] }).inject({
      method: "GET",
      url: "/api/articles?kind=topic,glossary&dirty_only=false",
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json().articles).toHaveLength(2);
  });

  it("400s on an invalid limit", async () => {
    const resp = await buildApp({}).inject({ method: "GET", url: "/api/articles?limit=0" });
    expect(resp.statusCode).toBe(400);
  });
});

describe("GET /api/articles/:id", () => {
  it("returns the article with citations", async () => {
    const resp = await buildApp({ getRow: fullArticleRow() }).inject({ method: "GET", url: `/api/articles/${ARTICLE_ID}` });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.slug).toBe("topic/buchwald-hartwig-amination");
    expect(body.stale).toBe(false);
    expect(Array.isArray(body.citations)).toBe(true);
  });

  it("404s when not found", async () => {
    const resp = await buildApp({ getRow: null }).inject({ method: "GET", url: `/api/articles/${ARTICLE_ID}` });
    expect(resp.statusCode).toBe(404);
  });

  it("400s on a non-uuid id", async () => {
    const resp = await buildApp({}).inject({ method: "GET", url: "/api/articles/not-a-uuid" });
    expect(resp.statusCode).toBe(400);
  });
});

describe("PATCH /api/articles/:id", () => {
  it("updates the body and bumps the revision/etag", async () => {
    const resp = await buildApp({
      patchRow: { id: ARTICLE_ID, slug: "topic/x", kind: "topic", revision: 3, etag: 4 },
    }).inject({
      method: "PATCH",
      url: `/api/articles/${ARTICLE_ID}`,
      payload: { body_md: "new body with [fact:abc]", change_note: "fixed a typo" },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.revision).toBe(3);
    expect(body.etag).toBe(4);
    expect(body.has_human_edits).toBe(true);
    expect(body.citations_recorded).toBe(1);
  });

  it("409s on an etag conflict", async () => {
    const resp = await buildApp({ patchRow: null, existsRow: { etag: 7 } }).inject({
      method: "PATCH",
      url: `/api/articles/${ARTICLE_ID}`,
      payload: { body_md: "x", expected_etag: 3 },
    });
    expect(resp.statusCode).toBe(409);
    expect(resp.json()).toMatchObject({ error: "etag_conflict", current_etag: 7 });
  });

  it("404s when the article does not exist", async () => {
    const resp = await buildApp({ patchRow: null, existsRow: null }).inject({
      method: "PATCH",
      url: `/api/articles/${ARTICLE_ID}`,
      payload: { body_md: "x" },
    });
    expect(resp.statusCode).toBe(404);
  });

  it("400s when body_md is missing", async () => {
    const resp = await buildApp({}).inject({ method: "PATCH", url: `/api/articles/${ARTICLE_ID}`, payload: { title: "only title" } });
    expect(resp.statusCode).toBe(400);
  });
});
