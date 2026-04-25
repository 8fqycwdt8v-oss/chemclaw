// Tests for buildMarkResearchDoneTool, _slugify, _buildMarkdown.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildMarkResearchDoneTool,
  _slugify,
  _buildMarkdown,
} from "../../../src/tools/builtins/mark_research_done.js";
import { mockPool } from "../../helpers/mock-pg.js";
import { makeCtx } from "../../helpers/make-ctx.js";

// ---------- _slugify ---------------------------------------------------------

describe("_slugify", () => {
  it("lowercases and hyphenates a title", () => {
    expect(_slugify("Yield Analysis 2025")).toBe("yield-analysis-2025");
  });

  it("strips leading and trailing hyphens", () => {
    expect(_slugify("  --- hello ---  ")).toBe("hello");
  });

  it("falls back to 'report' for blank/non-alphanumeric titles", () => {
    expect(_slugify("!!!")).toBe("report");
    expect(_slugify("")).toBe("report");
  });

  it("truncates to 60 chars", () => {
    const long = "a".repeat(80);
    expect(_slugify(long).length).toBeLessThanOrEqual(60);
  });
});

// ---------- _buildMarkdown ---------------------------------------------------

describe("_buildMarkdown", () => {
  const baseInput = {
    title: "Test Report",
    executive_summary: "Short summary.",
    sections: [{ heading: "Section A", body_markdown: "Body A." }],
    open_questions: [],
    contradictions: [],
    citations: [],
  };

  it("includes the title as H1", () => {
    const md = _buildMarkdown(baseInput);
    expect(md).toMatch(/^# Test Report/m);
  });

  it("includes executive summary under H2", () => {
    const md = _buildMarkdown(baseInput);
    expect(md).toContain("## Executive summary");
    expect(md).toContain("Short summary.");
  });

  it("includes open_questions section when non-empty", () => {
    const md = _buildMarkdown({ ...baseInput, open_questions: ["Why?"] });
    expect(md).toContain("## Open questions");
    expect(md).toContain("- Why?");
  });

  it("includes citations section when non-empty", () => {
    const md = _buildMarkdown({
      ...baseInput,
      citations: [{ ref: "[kg:f1]", detail: "fact about yield" }],
    });
    expect(md).toContain("## Citations");
    expect(md).toContain("[kg:f1] — fact about yield");
  });
});

// ---------- buildMarkResearchDoneTool ----------------------------------------

describe("buildMarkResearchDoneTool", () => {
  afterEach(() => vi.restoreAllMocks());

  const REPORT_UUID = "11111111-2222-3333-4444-555555555555";

  function makeToolDeps(extraOverrides = {}) {
    const { pool, client } = mockPool();
    // Begin/set_config/commit for withUserContext (3 calls) + INSERT
    client.queryResults.push(
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [], rowCount: 0 }, // set_config
      { rows: [{ id: REPORT_UUID }], rowCount: 1 }, // INSERT RETURNING
      { rows: [], rowCount: 0 }, // COMMIT
    );
    return {
      pool,
      client,
      deps: {
        pool,
        queryText: "What are the key findings?",
        promptVersion: 1,
        ...extraOverrides,
      },
    };
  }

  it("returns report_id and slug on success", async () => {
    const { pool, client, deps } = makeToolDeps();
    const tool = buildMarkResearchDoneTool(deps);
    const ctx = makeCtx();

    const result = await tool.execute(ctx, {
      title: "Phase 1 Summary",
      executive_summary: "Catalyst A outperformed B.",
      sections: [{ heading: "Results", body_markdown: "85% yield." }],
      open_questions: [],
      contradictions: [],
      citations: [],
    });

    expect(result.report_id).toBe(REPORT_UUID);
    expect(result.slug).toBe("phase-1-summary");
    expect(result.markdown_length).toBeGreaterThan(0);
    expect(client.querySpy).toHaveBeenCalled();
    void pool;
  });

  it("throws when INSERT returns no row", async () => {
    const { pool, client, deps } = makeToolDeps();
    // Override: return empty rows from INSERT
    client.queryResults = [
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [], rowCount: 0 }, // set_config
      { rows: [], rowCount: 0 }, // INSERT (empty — simulates error)
      { rows: [], rowCount: 0 }, // ROLLBACK
    ];
    const tool = buildMarkResearchDoneTool(deps);
    const ctx = makeCtx();

    await expect(
      tool.execute(ctx, {
        title: "X",
        executive_summary: "Y",
        sections: [{ heading: "Z", body_markdown: "W" }],
        open_questions: [],
        contradictions: [],
        citations: [],
      }),
    ).rejects.toThrow(/INSERT did not return a row/);
    void pool;
    void client;
  });

  it("inputSchema rejects empty title", () => {
    const { pool } = mockPool();
    const tool = buildMarkResearchDoneTool({
      pool,
      queryText: "q",
      promptVersion: 1,
    });
    const r = tool.inputSchema.safeParse({
      title: "",
      executive_summary: "x",
      sections: [{ heading: "s", body_markdown: "b" }],
    });
    expect(r.success).toBe(false);
  });

  it("inputSchema rejects sections array with 0 items", () => {
    const { pool } = mockPool();
    const tool = buildMarkResearchDoneTool({
      pool,
      queryText: "q",
      promptVersion: 1,
    });
    const r = tool.inputSchema.safeParse({
      title: "T",
      executive_summary: "E",
      sections: [],
    });
    expect(r.success).toBe(false);
  });
});
