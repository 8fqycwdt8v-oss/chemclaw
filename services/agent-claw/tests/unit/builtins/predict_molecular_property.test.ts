// Tests for buildPredictMolecularPropertyTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildPredictMolecularPropertyTool } from "../../../src/tools/builtins/predict_molecular_property.js";

const CHEMPROP_URL = "http://mcp-chemprop:8009";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

const FAKE_RESPONSE = {
  predictions: [{ smiles: "c1ccccc1", value: 1.99, std: 0.05 }],
};

afterEach(() => vi.unstubAllGlobals());

describe("buildPredictMolecularPropertyTool", () => {
  it("calls correct URL for logP prediction", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildPredictMolecularPropertyTool(CHEMPROP_URL);
    const result = await tool.execute(makeCtx(), { smiles_list: ["c1ccccc1"], property: "logP" });

    expect(result.predictions).toHaveLength(1);
    expect(result.predictions[0].value).toBeCloseTo(1.99);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CHEMPROP_URL}/predict_property`);
    expect(JSON.parse(init.body as string)).toMatchObject({ property: "logP" });
  });

  it("accepts all valid property enum values", () => {
    const tool = buildPredictMolecularPropertyTool(CHEMPROP_URL);
    for (const prop of ["logP", "logS", "mp", "bp"] as const) {
      expect(tool.inputSchema.safeParse({ smiles_list: ["C"], property: prop }).success).toBe(true);
    }
  });

  it("rejects invalid property", () => {
    const tool = buildPredictMolecularPropertyTool(CHEMPROP_URL);
    expect(
      tool.inputSchema.safeParse({ smiles_list: ["C"], property: "pKa" }).success,
    ).toBe(false);
  });

  it("rejects empty smiles_list", () => {
    const tool = buildPredictMolecularPropertyTool(CHEMPROP_URL);
    expect(tool.inputSchema.safeParse({ smiles_list: [], property: "logP" }).success).toBe(false);
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad smiles" }),
    );
    const tool = buildPredictMolecularPropertyTool(CHEMPROP_URL);
    await expect(
      tool.execute(makeCtx(), { smiles_list: ["INVALID"], property: "logP" }),
    ).rejects.toThrow(/400/);
  });
});
