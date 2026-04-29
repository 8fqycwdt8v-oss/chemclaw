// Tests for the analyze_csv builtin tool.
// Uses csv_text path only (no DB / mcp-doc-fetcher needed).

import { describe, it, expect, vi } from "vitest";
import { buildAnalyzeCsvTool } from "../../../src/tools/builtins/analyze_csv.js";
import type { ToolContext } from "../../../src/core/types.js";
import type { Pool } from "pg";

// Minimal pool stub — not used by csv_text path.
const stubPool = {} as Pool;
const stubDocFetcherUrl = "http://localhost:8006";

function makeCtx(): ToolContext {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>();
  scratchpad.set("seenFactIds", seenFactIds);
  return {
    userEntraId: "test@example.com",
    seenFactIds,
    scratchpad,
  };
}

const tool = buildAnalyzeCsvTool(stubPool, stubDocFetcherUrl);

const SIMPLE_CSV = `name,purity,yield_pct,water_content
compound_A,99.2,87.3,0.1
compound_B,98.1,72.5,0.3
compound_C,97.5,91.0,0.08
compound_D,,65.0,0.5
`;

const ctx = makeCtx();

describe("analyze_csv — happy path", () => {
  it("returns row_count and column_summary for a simple CSV", async () => {
    const result = await tool.execute(ctx, {
      csv_text: SIMPLE_CSV,
      query: "how many rows",
    });
    expect(result.row_count).toBe(4);
    expect(result.column_summary.length).toBe(4);
    expect(result.answer_to_query).toMatch(/4 rows/);
  });

  it("computes numeric column stats correctly", async () => {
    const result = await tool.execute(ctx, {
      csv_text: SIMPLE_CSV,
      query: "statistics",
    });
    const purityCol = result.column_summary.find((c) => c.name === "purity");
    expect(purityCol).toBeTruthy();
    expect(purityCol!.type).toBe("number");
    // 3 non-empty values: 99.2, 98.1, 97.5
    expect(purityCol!.n_missing).toBe(1);
    expect(purityCol!.min).toBeCloseTo(97.5);
    expect(purityCol!.max).toBeCloseTo(99.2);
  });

  it("detects string columns", async () => {
    const result = await tool.execute(ctx, {
      csv_text: SIMPLE_CSV,
      query: "column names",
    });
    const nameCol = result.column_summary.find((c) => c.name === "name");
    expect(nameCol?.type).toBe("string");
  });

  it("answers min/max queries for a named column", async () => {
    const result = await tool.execute(ctx, {
      csv_text: SIMPLE_CSV,
      query: "what is the minimum yield_pct",
    });
    expect(result.answer_to_query).toMatch(/65/);
  });

  it("answers threshold queries (above/below)", async () => {
    const result = await tool.execute(ctx, {
      csv_text: SIMPLE_CSV,
      query: "how many rows have yield_pct above 80",
    });
    // compound_A (87.3) and compound_C (91.0) → 2
    expect(result.answer_to_query).toMatch(/2/);
  });

  it("returns __llm_judgement_required__ for open-ended queries", async () => {
    const result = await tool.execute(ctx, {
      csv_text: SIMPLE_CSV,
      query: "is the data normally distributed and what does it suggest about the process?",
    });
    expect(result.answer_to_query).toBe("__llm_judgement_required__");
  });
});

describe("analyze_csv — size cap", () => {
  it("throws when csv_text exceeds 1 MB", async () => {
    // Build a string just over 1 MB.
    const bigRow = "x,".repeat(500) + "\n";
    const bigCsv = bigRow.repeat(3000); // well over 1 MB
    await expect(
      tool.execute(ctx, { csv_text: bigCsv, query: "count" }),
    ).rejects.toThrow(/1 MB/);
  });
});

describe("analyze_csv — validation", () => {
  it("throws when neither document_id nor csv_text is supplied", async () => {
    await expect(
      tool.execute(ctx, { query: "count" }),
    ).rejects.toThrow(/document_id or csv_text/);
  });

  it("throws when both document_id and csv_text are supplied", async () => {
    await expect(
      tool.execute(ctx, {
        document_id: "11111111-1111-1111-1111-111111111111",
        csv_text: "a,b\n1,2\n",
        query: "count",
      }),
    ).rejects.toThrow(/OR csv_text/);
  });

  it("reports missing values in the column summary", async () => {
    const csvWithMissing = "a,b\n1,\n2,3\n";
    const result = await tool.execute(ctx, {
      csv_text: csvWithMissing,
      query: "missing",
    });
    expect(result.answer_to_query).toMatch(/b \(1\)/);
  });
});
