// Tests for buildPredictReactionYieldTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildPredictReactionYieldTool } from "../../../src/tools/builtins/predict_reaction_yield.js";

const CHEMPROP_URL = "http://mcp-chemprop:8009";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

const FAKE_RESPONSE = {
  predictions: [
    { rxn_smiles: "CC>>CC", predicted_yield: 85.3, std: 2.1, model_id: "yield_model@v1" },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("buildPredictReactionYieldTool", () => {
  it("calls correct URL and returns predictions", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildPredictReactionYieldTool(CHEMPROP_URL);
    const result = await tool.execute(makeCtx(), { rxn_smiles_list: ["CC>>CC"] });

    expect(result.predictions).toHaveLength(1);
    expect(result.predictions[0].predicted_yield).toBeCloseTo(85.3);
    expect(result.predictions[0].model_id).toBe("yield_model@v1");

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe(`${CHEMPROP_URL}/predict_yield`);
  });

  it("inputSchema rejects empty list", () => {
    const tool = buildPredictReactionYieldTool(CHEMPROP_URL);
    expect(tool.inputSchema.safeParse({ rxn_smiles_list: [] }).success).toBe(false);
  });

  it("inputSchema rejects list longer than 100", () => {
    const tool = buildPredictReactionYieldTool(CHEMPROP_URL);
    expect(
      tool.inputSchema.safeParse({ rxn_smiles_list: Array(101).fill("CC>>CC") }).success,
    ).toBe(false);
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "not ready" }),
    );
    const tool = buildPredictReactionYieldTool(CHEMPROP_URL);
    await expect(
      tool.execute(makeCtx(), { rxn_smiles_list: ["CC>>CC"] }),
    ).rejects.toThrow(/503/);
  });

  it("strips trailing slash from URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildPredictReactionYieldTool(`${CHEMPROP_URL}/`);
    await tool.execute(makeCtx(), { rxn_smiles_list: ["CC>>CC"] });

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe(`${CHEMPROP_URL}/predict_yield`);
  });
});
