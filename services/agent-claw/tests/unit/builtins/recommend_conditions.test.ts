// Tests for buildRecommendConditionsTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildRecommendConditionsTool } from "../../../src/tools/builtins/recommend_conditions.js";

const ASKCOS_URL = "http://mcp-askcos:8007";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

const FAKE_RESPONSE = {
  recommendations: [
    {
      catalysts: [{ smiles: "[Pd]", name: "Pd(OAc)2" }],
      reagents: [{ smiles: "C(C)(C)(C)[O-]", name: "tBuOK" }],
      solvents: [
        { smiles: "O", name: "" },
        { smiles: "C1CCOC1", name: "" },
      ],
      temperature_c: 80.0,
      score: 0.91,
    },
    {
      catalysts: [],
      reagents: [{ smiles: "[Cs+]", name: "Cs2CO3" }],
      solvents: [{ smiles: "CCOCC", name: "DEE" }],
      temperature_c: null,
      score: 0.42,
    },
  ],
  model_id: "askcos_condition_recommender@v2",
};

afterEach(() => vi.unstubAllGlobals());

describe("buildRecommendConditionsTool", () => {
  it("calls correct URL and returns recommendations", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildRecommendConditionsTool(ASKCOS_URL);
    const result = await tool.execute(makeCtx(), {
      reactants_smiles: "Brc1ccc(OC)cc1.C1COCCN1",
      product_smiles: "COc1ccc(N2CCOCC2)cc1",
      top_k: 5,
    });

    expect(result.recommendations).toHaveLength(2);
    expect(result.recommendations[0].score).toBeCloseTo(0.91);
    expect(result.recommendations[0].temperature_c).toBeCloseTo(80.0);
    expect(result.recommendations[0].catalysts[0].name).toBe("Pd(OAc)2");
    expect(result.recommendations[1].temperature_c).toBeNull();
    expect(result.model_id).toBe("askcos_condition_recommender@v2");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ASKCOS_URL}/recommend_conditions`);
    const body = JSON.parse(init.body as string);
    expect(body.reactants_smiles).toBe("Brc1ccc(OC)cc1.C1COCCN1");
    expect(body.top_k).toBe(5);
  });

  it("inputSchema rejects empty reactants_smiles", () => {
    const tool = buildRecommendConditionsTool(ASKCOS_URL);
    expect(
      tool.inputSchema.safeParse({
        reactants_smiles: "",
        product_smiles: "C",
      }).success,
    ).toBe(false);
  });

  it("inputSchema rejects empty product_smiles", () => {
    const tool = buildRecommendConditionsTool(ASKCOS_URL);
    expect(
      tool.inputSchema.safeParse({
        reactants_smiles: "C",
        product_smiles: "",
      }).success,
    ).toBe(false);
  });

  it("inputSchema rejects top_k > 20", () => {
    const tool = buildRecommendConditionsTool(ASKCOS_URL);
    expect(
      tool.inputSchema.safeParse({
        reactants_smiles: "C",
        product_smiles: "C",
        top_k: 99,
      }).success,
    ).toBe(false);
  });

  it("inputSchema applies default top_k=5 when omitted", () => {
    const tool = buildRecommendConditionsTool(ASKCOS_URL);
    const parsed = tool.inputSchema.safeParse({
      reactants_smiles: "C",
      product_smiles: "C",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.top_k).toBe(5);
    }
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "askcos not ready",
      }),
    );
    const tool = buildRecommendConditionsTool(ASKCOS_URL);
    await expect(
      tool.execute(makeCtx(), {
        reactants_smiles: "C",
        product_smiles: "C",
        top_k: 5,
      }),
    ).rejects.toThrow(/503/);
  });

  it("strips trailing slash from URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildRecommendConditionsTool(`${ASKCOS_URL}/`);
    await tool.execute(makeCtx(), {
      reactants_smiles: "C",
      product_smiles: "C",
      top_k: 5,
    });

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe(`${ASKCOS_URL}/recommend_conditions`);
  });
});
