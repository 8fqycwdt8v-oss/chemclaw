// Unit tests for the four knowledge-wiki builtins (ADR 012 Phase 1):
// read_article / list_articles / upsert_article / request_article.
//
// The DB is exercised end-to-end against a Postgres testcontainer elsewhere;
// here we pin the parts that don't need a real DB — the feature gate, input
// validation, the agent-authorable-kind and human-block guards, and the SQL
// touchpoints (a refactor that drops the revision INSERT or the citation
// unnest fails here, which is the point). Mocking follows
// synthesis_campaigns.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool, PoolClient } from "pg";

import { buildReadArticleTool } from "../../../src/tools/builtins/read_article.js";
import { buildListArticlesTool } from "../../../src/tools/builtins/list_articles.js";
import { buildUpsertArticleTool } from "../../../src/tools/builtins/upsert_article.js";
import { buildRequestArticleTool } from "../../../src/tools/builtins/request_article.js";
import { setFeatureFlagRegistry } from "../../../src/config/flags.js";
import type { FeatureFlagRegistry } from "../../../src/config/flags.js";
import { makeCtx } from "../../helpers/make-ctx.js";

interface Captured {
  text: string;
  values: readonly unknown[];
}

function makeRespondingPool(
  responder: (text: string, values: readonly unknown[]) => unknown[] | undefined,
): { pool: Pool; captured: Captured[] } {
  const captured: Captured[] = [];
  const client: Partial<PoolClient> = {
    query: vi.fn(async (textOrConfig: unknown, values?: readonly unknown[]) => {
      const text =
        typeof textOrConfig === "string"
          ? textOrConfig
          : (textOrConfig as { text: string }).text;
      const vals = values ?? [];
      captured.push({ text, values: vals });
      return { rows: responder(text, vals) ?? [] } as unknown as Awaited<
        ReturnType<NonNullable<PoolClient["query"]>>
      >;
    }) as unknown as PoolClient["query"],
    release: vi.fn(),
  };
  const pool: Partial<Pool> = { connect: vi.fn(async () => client as PoolClient) };
  return { pool: pool as Pool, captured };
}

function setFlag(enabled: boolean): void {
  setFeatureFlagRegistry({ isEnabled: async () => enabled } as unknown as FeatureFlagRegistry);
}

const ARTICLE_ID = "11111111-1111-1111-1111-111111111111";

function articleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ARTICLE_ID,
    slug: "topic/buchwald-hartwig-amination",
    kind: "topic",
    title: "Buchwald–Hartwig amination",
    summary: "Pd-catalysed C–N coupling.",
    body_md: "Couples an aryl halide with an amine. See [fact:22222222-2222-2222-2222-222222222222].",
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
    ...overrides,
  };
}

beforeEach(() => setFlag(true));

describe("read_article", () => {
  it("throws when the wiki feature flag is off", async () => {
    setFlag(false);
    const { pool } = makeRespondingPool(() => []);
    const tool = buildReadArticleTool(pool);
    await expect(tool.execute(makeCtx(), { slug: "topic/x" })).rejects.toThrow(/wiki\.enabled/);
  });

  it("returns the article + citations when found", async () => {
    const { pool, captured } = makeRespondingPool((text) => {
      if (text.includes('FROM knowledge_articles')) return [articleRow()];
      if (text.includes('FROM knowledge_article_citations')) {
        return [{ cite_kind: "fact", cite_ref: "22222222-2222-2222-2222-222222222222", anchor: null, note: null }];
      }
      return [];
    });
    const tool = buildReadArticleTool(pool);
    const out = await tool.execute(makeCtx(), { slug: "topic/buchwald-hartwig-amination" });
    expect(out.found).toBe(true);
    expect(out.article?.slug).toBe("topic/buchwald-hartwig-amination");
    expect(out.article?.stale).toBe(false);
    expect(out.article?.citations).toHaveLength(1);
    expect(out.article?.citations[0]?.cite_kind).toBe("fact");
    // Read-only tool.
    expect(tool.annotations?.readOnly).toBe(true);
    // No write SQL issued (note: "updated_at" column names are not writes).
    expect(captured.some((c) => /\bINSERT INTO\b|\bUPDATE knowledge_articles\b/.test(c.text))).toBe(false);
  });

  it("returns found=false when the slug does not exist", async () => {
    const { pool } = makeRespondingPool(() => []);
    const tool = buildReadArticleTool(pool);
    const out = await tool.execute(makeCtx(), { slug: "topic/nope" });
    expect(out.found).toBe(false);
    expect(out.article).toBeNull();
  });

  it("rejects input with neither slug nor id", () => {
    expect(() => buildReadArticleTool({} as Pool).inputSchema.parse({})).toThrow();
  });
});

describe("list_articles", () => {
  it("maps rows to summaries and surfaces the dirty flag", async () => {
    const { pool, captured } = makeRespondingPool((text) => {
      if (text.includes('FROM knowledge_articles')) {
        return [articleRow({ dirty: true }), articleRow({ id: "33333333-3333-3333-3333-333333333333", slug: "glossary", kind: "glossary" })];
      }
      return [];
    });
    const tool = buildListArticlesTool(pool);
    const out = await tool.execute(makeCtx(), { dirty_only: true, limit: 50, include_archived: false });
    expect(out.articles).toHaveLength(2);
    expect(out.articles[0]?.dirty).toBe(true);
    // dirty_only added a `ka.dirty` predicate.
    expect(captured.some((c) => /WHERE[\s\S]*ka\.dirty/.test(c.text))).toBe(true);
  });

  it("throws when the feature flag is off", async () => {
    setFlag(false);
    const { pool } = makeRespondingPool(() => []);
    await expect(buildListArticlesTool(pool).execute(makeCtx(), { dirty_only: false, limit: 50, include_archived: false })).rejects.toThrow(/wiki\.enabled/);
  });
});

describe("upsert_article", () => {
  it("rejects a kind that is not agent-authorable", async () => {
    const { pool } = makeRespondingPool(() => []);
    const tool = buildUpsertArticleTool(pool);
    await expect(
      tool.execute(makeCtx(), {
        slug: "compound/RYYVLZVUVIJVGH-UHFFFAOYSA-N",
        kind: "compound",
        title: "X",
        body_md: "body",
      }),
    ).rejects.toThrow(/maintained by the wiki_pages projector|request_article/);
  });

  it("rejects a body that contains a human:begin marker", async () => {
    const { pool } = makeRespondingPool(() => []);
    const tool = buildUpsertArticleTool(pool);
    await expect(
      tool.execute(makeCtx(), {
        slug: "topic/x",
        kind: "topic",
        title: "X",
        body_md: "intro\n<!-- human:begin owner=alice@x.com -->trusted\n<!-- human:end -->\noutro",
      }),
    ).rejects.toThrow(/human:begin/);
  });

  it("inserts the page, a revision row, and parsed citations", async () => {
    const { pool, captured } = makeRespondingPool((text) => {
      if (text.includes('INSERT INTO knowledge_articles')) return [{ id: ARTICLE_ID, revision: 1 }];
      return [];
    });
    const tool = buildUpsertArticleTool(pool);
    const out = await tool.execute(makeCtx("scientist@pharma.com"), {
      slug: "topic/buchwald-hartwig-amination",
      kind: "topic",
      title: "Buchwald–Hartwig amination",
      summary: "Pd-catalysed C–N coupling.",
      body_md: "Couples ArX + amine. Evidence: [fact:22222222-2222-2222-2222-222222222222] and [chunk:c-9].",
    });
    expect(out.created).toBe(true);
    expect(out.revision).toBe(1);
    expect(out.citations_recorded).toBe(2);
    expect(captured.some((c) => c.text.includes('INSERT INTO knowledge_article_revisions'))).toBe(true);
    const citeInsert = captured.find((c) => c.text.includes('INSERT INTO knowledge_article_citations'));
    expect(citeInsert).toBeDefined();
    // unnest of the (kind[], ref[]) arrays.
    expect(citeInsert?.values).toContainEqual(["fact", "chunk"]);
  });

  it("refuses to overwrite a page with human edits (conflict-update returns no row)", async () => {
    const { pool } = makeRespondingPool((text) => {
      if (text.includes('INSERT INTO knowledge_articles')) return []; // ON CONFLICT WHERE has_human_edits=false blocked it
      return [];
    });
    const tool = buildUpsertArticleTool(pool);
    await expect(
      tool.execute(makeCtx(), { slug: "topic/x", kind: "topic", title: "X", body_md: "body" }),
    ).rejects.toThrow(/human-authored content/);
  });
});

describe("request_article", () => {
  it("creates a dirty stub for an entity-backed page", async () => {
    const { pool, captured } = makeRespondingPool((text) => {
      if (text.includes('INSERT INTO knowledge_articles')) {
        return [{ id: ARTICLE_ID, dirty: true, dirty_reason: "manual:requested", revision: 1 }];
      }
      return [];
    });
    const tool = buildRequestArticleTool(pool);
    const out = await tool.execute(makeCtx(), {
      slug: "compound/RYYVLZVUVIJVGH-UHFFFAOYSA-N",
      kind: "compound",
      entity_ref: { label: "Compound", id_property: "inchikey", id_value: "RYYVLZVUVIJVGH-UHFFFAOYSA-N" },
      reason: "cited but no page",
    });
    expect(out.created).toBe(true);
    expect(out.dirty).toBe(true);
    expect(out.dirty_reason).toMatch(/manual:requested/);
    // dirty_reason carries the supplied reason.
    const ins = captured.find((c) => c.text.includes('INSERT INTO knowledge_articles'));
    expect(ins?.values.some((v) => typeof v === "string" && v.includes("cited but no page"))).toBe(true);
  });
});
