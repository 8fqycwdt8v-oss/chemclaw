// Phase 3 — find_similar_compounds builtin: SQL injection defense + happy path.

import { describe, it, expect, vi } from "vitest";
import { buildFindSimilarCompoundsTool } from "../../../src/tools/builtins/find_similar_compounds.js";

const RDKIT = "http://mcp-rdkit:8001";

function makeCtx() {
  return {
    userEntraId: "test@example.com",
    scratchpad: new Map<string, unknown>([["seenFactIds", new Set<string>()]]),
    seenFactIds: new Set<string>(),
  };
}

function makePool(rows: Array<{ inchikey: string; smiles_canonical: string | null; similarity: number }>) {
  return {
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (/SELECT inchikey/i.test(sql)) return { rows, rowCount: rows.length };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    }),
  } as unknown as Parameters<typeof buildFindSimilarCompoundsTool>[0];
}

describe("find_similar_compounds", () => {
  it("schema rejects an unknown fingerprint", () => {
    const tool = buildFindSimilarCompoundsTool(makePool([]), RDKIT);
    expect(
      tool.inputSchema.safeParse({ smiles: "CCO", fingerprint: "drop-table" }).success,
    ).toBe(false);
  });

  it("execute rejects an unknown fingerprint even if Zod is bypassed", async () => {
    const tool = buildFindSimilarCompoundsTool(makePool([]), RDKIT);
    // Bypass schema validation to simulate a future regression.
    await expect(
      tool.execute(makeCtx(), {
        smiles: "CCO",
        // @ts-expect-error - intentional bypass
        fingerprint: "any_arbitrary_column",
        k: 5,
        min_similarity: 0,
      }),
    ).rejects.toThrow(/fingerprint must be one of/);
  });

  it("schema rejects empty smiles", () => {
    const tool = buildFindSimilarCompoundsTool(makePool([]), RDKIT);
    expect(tool.inputSchema.safeParse({ smiles: "" }).success).toBe(false);
  });
});
