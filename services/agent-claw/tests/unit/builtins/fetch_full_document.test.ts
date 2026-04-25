// Tests for buildFetchFullDocumentTool (alias for fetch_original_document markdown path).

import { describe, it, expect } from "vitest";
import { buildFetchFullDocumentTool } from "../../../src/tools/builtins/fetch_full_document.js";
import { mockPool } from "../../helpers/mock-pg.js";
import { makeCtx } from "../../helpers/make-ctx.js";

const DOC_UUID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function makeDocRow(overrides: Record<string, unknown> = {}) {
  return {
    document_id: DOC_UUID,
    sha256: "abc123",
    title: "SOP-001 Synthesis Protocol",
    source_type: "SOP",
    version: "v2",
    effective_date: "2025-01-01",
    parsed_markdown: "# SOP-001\n\nStep 1: Add catalyst.",
    chunk_count: 3,
    ...overrides,
  };
}

describe("buildFetchFullDocumentTool", () => {
  it("returns full document markdown on success", async () => {
    const { pool, client } = mockPool();
    client.queryResults.push(
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [], rowCount: 0 }, // set_config
      { rows: [makeDocRow()], rowCount: 1 }, // SELECT
      { rows: [], rowCount: 0 }, // COMMIT
    );

    const tool = buildFetchFullDocumentTool(pool);
    const ctx = makeCtx();
    const result = await tool.execute(ctx, { document_id: DOC_UUID });

    expect(result.document_id).toBe(DOC_UUID);
    expect(result.parsed_markdown).toContain("Step 1: Add catalyst.");
    expect(result.title).toBe("SOP-001 Synthesis Protocol");
    expect(result.chunk_count).toBe(3);
  });

  it("throws when document is not found (RLS block or missing)", async () => {
    const { pool, client } = mockPool();
    client.queryResults.push(
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [], rowCount: 0 }, // set_config
      { rows: [], rowCount: 0 }, // SELECT returns nothing
      { rows: [], rowCount: 0 }, // ROLLBACK
    );

    const tool = buildFetchFullDocumentTool(pool);
    await expect(
      tool.execute(makeCtx(), { document_id: DOC_UUID }),
    ).rejects.toThrow(/not found or not accessible/);
  });

  it("truncates markdown exceeding 200,000 chars", async () => {
    const longMarkdown = "A".repeat(250_000);
    const { pool, client } = mockPool();
    client.queryResults.push(
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [makeDocRow({ parsed_markdown: longMarkdown })], rowCount: 1 },
      { rows: [], rowCount: 0 },
    );

    const tool = buildFetchFullDocumentTool(pool);
    const result = await tool.execute(makeCtx(), { document_id: DOC_UUID });

    expect(result.parsed_markdown!.length).toBeLessThanOrEqual(200_100); // cap + ellipsis marker
    expect(result.parsed_markdown).toContain("[truncated");
  });

  it("inputSchema rejects non-UUID document_id", () => {
    const { pool } = mockPool();
    const tool = buildFetchFullDocumentTool(pool);
    const r = tool.inputSchema.safeParse({ document_id: "not-a-uuid" });
    expect(r.success).toBe(false);
  });
});
