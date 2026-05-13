// Tests for buildSearchKnowledgeTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildSearchKnowledgeTool,
  _rrfForTests,
} from "../../../src/tools/builtins/search_knowledge.js";
import { mockPool } from "../../helpers/mock-pg.js";
import { makeCtx } from "../../helpers/make-ctx.js";

const MCP_EMBEDDER_URL = "http://mcp-embedder:8004";

const EMBED_RESPONSE = {
  vectors: [new Array(1024).fill(0.01)],
};

const DB_CHUNK_ROW = {
  chunk_id: "cccccccc-1111-2222-3333-444444444444",
  document_id: "dddddddd-1111-2222-3333-444444444444",
  heading_path: "Section 1 > Methods",
  text: "Catalyst A was used at 85°C.",
  source_type: "SOP",
  document_title: "SOP-001 Reaction Protocol",
  original_uri: "s3://docs/sop-001.pdf",
  distance: 0.15,
};

function mockFetchEmbed(embedBody: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify(embedBody),
  });
}

describe("buildSearchKnowledgeTool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("dense mode: calls embedder and returns scored hits with citations", async () => {
    vi.stubGlobal("fetch", mockFetchEmbed(EMBED_RESPONSE));

    const { pool, client } = mockPool();
    // withUserContext: BEGIN, set_config, dense-search result, COMMIT
    client.queryResults.push(
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [], rowCount: 0 }, // set_config
      { rows: [DB_CHUNK_ROW], rowCount: 1 },
      { rows: [], rowCount: 0 }, // COMMIT
    );

    const tool = buildSearchKnowledgeTool(pool, MCP_EMBEDDER_URL);
    const result = await tool.execute(makeCtx(), {
      query: "catalyst temperature",
      k: 5,
      mode: "dense",
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.chunk_id).toBe(DB_CHUNK_ROW.chunk_id);
    expect(result.hits[0]?.citation.source_kind).toBe("document_chunk");
    expect(result.hits[0]?.citation.snippet).toContain("Catalyst A");
    expect(result.mode).toBe("dense");
  });

  it("throws when embedder returns empty vector", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ vectors: [[]] }),
      }),
    );

    const { pool } = mockPool();
    const tool = buildSearchKnowledgeTool(pool, MCP_EMBEDDER_URL);

    await expect(
      tool.execute(makeCtx(), { query: "x", k: 5, mode: "dense" }),
    ).rejects.toThrow(/empty vector/);
  });

  it("sparse mode: skips embedder and returns hits from DB", async () => {
    // No fetch needed for sparse — but we still stub to guard against accidental calls
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "should not be called",
    });
    vi.stubGlobal("fetch", mockFetch);

    const { pool, client } = mockPool();
    client.queryResults.push(
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [], rowCount: 0 }, // set_config
      { rows: [{ ...DB_CHUNK_ROW, trgm_sim: 0.65 }], rowCount: 1 },
      { rows: [], rowCount: 0 }, // COMMIT
    );

    const tool = buildSearchKnowledgeTool(pool, MCP_EMBEDDER_URL);
    const result = await tool.execute(makeCtx(), {
      query: "catalyst temperature",
      k: 5,
      mode: "sparse",
    });

    expect(result.hits).toHaveLength(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("inputSchema rejects query over 4000 chars", () => {
    const { pool } = mockPool();
    const tool = buildSearchKnowledgeTool(pool, MCP_EMBEDDER_URL);
    const r = tool.inputSchema.safeParse({ query: "x".repeat(4001), k: 5 });
    expect(r.success).toBe(false);
  });

  // ADR 012 Phase 3c — the knowledge-wiki arm.

  const DB_WIKI_ROW = {
    chunk_id: "99999999-1111-2222-3333-444444444444",
    article_id: "aaaaaaaa-1111-2222-3333-444444444444",
    slug: "project/NCE-0042",
    article_kind: "nce_project",
    article_title: "Project Aurora",
    heading_path: "Synthetic route",
    text: "The Buchwald amination step gave 92% yield.",
    distance: 0.12,
  };

  it("hybrid mode (default include_wiki) surfaces a knowledge-wiki page hit", async () => {
    vi.stubGlobal("fetch", mockFetchEmbed(EMBED_RESPONSE));
    const { pool, client } = mockPool();
    // BEGIN, set_config, [denseDoc, sparseDoc, denseWiki, sparseWiki], COMMIT
    client.queryResults.push(
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [], rowCount: 0 }, // set_config
      { rows: [DB_CHUNK_ROW], rowCount: 1 },        // denseDoc
      { rows: [], rowCount: 0 },                    // sparseDoc
      { rows: [DB_WIKI_ROW], rowCount: 1 },         // denseWiki
      { rows: [], rowCount: 0 },                    // sparseWiki
      { rows: [], rowCount: 0 }, // COMMIT
    );

    const tool = buildSearchKnowledgeTool(pool, MCP_EMBEDDER_URL);
    const result = await tool.execute(makeCtx(), { query: "buchwald yield", k: 10, mode: "hybrid" });

    const docHit = result.hits.find((h) => h.kind === "document");
    const wikiHit = result.hits.find((h) => h.kind === "wiki");
    expect(docHit?.document_id).toBe(DB_CHUNK_ROW.document_id);
    expect(docHit?.citation.source_kind).toBe("document_chunk");
    expect(wikiHit?.slug).toBe("project/NCE-0042");
    expect(wikiHit?.article_id).toBe(DB_WIKI_ROW.article_id);
    expect(wikiHit?.document_id).toBeNull();
    expect(wikiHit?.source_type).toBe("nce_project");
    expect(wikiHit?.document_title).toBe("Project Aurora");
    expect(wikiHit?.citation.source_kind).toBe("knowledge_article");
    expect(wikiHit?.citation.source_uri).toBe("project/NCE-0042");
    // The wiki arm SQL was executed.
    expect(client.querySpy.mock.calls.some((c) => String(c[0]).includes("wiki_chunks"))).toBe(true);
  });

  it("include_wiki=false skips the wiki_chunks arm entirely", async () => {
    vi.stubGlobal("fetch", mockFetchEmbed(EMBED_RESPONSE));
    const { pool, client } = mockPool();
    client.queryResults.push(
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [], rowCount: 0 }, // set_config
      { rows: [DB_CHUNK_ROW], rowCount: 1 }, // denseDoc
      { rows: [], rowCount: 0 },             // sparseDoc
      { rows: [], rowCount: 0 }, // COMMIT
    );

    const tool = buildSearchKnowledgeTool(pool, MCP_EMBEDDER_URL);
    const result = await tool.execute(makeCtx(), { query: "x", k: 5, mode: "hybrid", include_wiki: false });

    expect(result.hits.every((h) => h.kind === "document")).toBe(true);
    expect(client.querySpy.mock.calls.some((c) => String(c[0]).includes("wiki_chunks"))).toBe(false);
  });
});

// ---------- RRF unit tests ---------------------------------------------------

describe("_rrfForTests (reciprocal rank fusion)", () => {
  it("fuses two rankings and merges scores", () => {
    const rankA = [
      { chunk_id: "a", document_id: "d", heading_path: null, text: "A", source_type: "SOP", document_title: null, original_uri: null },
      { chunk_id: "b", document_id: "d", heading_path: null, text: "B", source_type: "SOP", document_title: null, original_uri: null },
    ];
    const rankB = [
      { chunk_id: "b", document_id: "d", heading_path: null, text: "B", source_type: "SOP", document_title: null, original_uri: null },
      { chunk_id: "a", document_id: "d", heading_path: null, text: "A", source_type: "SOP", document_title: null, original_uri: null },
    ];

    const result = _rrfForTests([rankA, rankB], 60, 2);
    expect(result).toHaveLength(2);
    // Both 'a' and 'b' appear in both rankings so both get boosted scores.
    expect(result[0]?.score).toBeGreaterThan(0);
  });

  it("returns at most `limit` results", () => {
    const row = { chunk_id: "x", document_id: "d", heading_path: null, text: "X", source_type: "SOP", document_title: null, original_uri: null };
    const ranking = [row, { ...row, chunk_id: "y" }, { ...row, chunk_id: "z" }];
    const result = _rrfForTests([ranking], 60, 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("chunk appearing in only one ranking still gets a score", () => {
    const row = { chunk_id: "solo", document_id: "d", heading_path: null, text: "X", source_type: "SOP", document_title: null, original_uri: null };
    const result = _rrfForTests([[row]], 60, 5);
    expect(result).toHaveLength(1);
    expect(result[0]?.score).toBeGreaterThan(0);
  });
});
