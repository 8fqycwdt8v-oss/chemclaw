// Tests for buildScoreGreenChemistryTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildScoreGreenChemistryTool } from "../../../src/tools/builtins/score_green_chemistry.js";

const URL_ = "http://mcp-green-chemistry:8019";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

const FAKE_RESPONSE = {
  results: [
    {
      input: { smiles: "ClCCl" },
      canonical_smiles: "ClCCl",
      chem21_class: "HighlyHazardous",
      chem21_score: 9,
      gsk_class: "Major Issues",
      pfizer_class: "Avoid",
      az_class: "Avoid",
      sanofi_class: "Red",
      acs_unified_class: "Avoid",
      match_confidence: "smiles_exact",
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("buildScoreGreenChemistryTool", () => {
  it("calls /score_solvents and returns results", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildScoreGreenChemistryTool(URL_);
    const result = await tool.execute(makeCtx(), { solvents: [{ smiles: "ClCCl" }] });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].chem21_class).toBe("HighlyHazardous");

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe(`${URL_}/score_solvents`);
  });

  it("rejects empty solvents list", () => {
    const tool = buildScoreGreenChemistryTool(URL_);
    expect(tool.inputSchema.safeParse({ solvents: [] }).success).toBe(false);
  });

  it("strips trailing slash", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);
    const tool = buildScoreGreenChemistryTool(`${URL_}/`);
    await tool.execute(makeCtx(), { solvents: [{ smiles: "ClCCl" }] });
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe(`${URL_}/score_solvents`);
  });
});
