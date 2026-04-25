// Tests for buildScreenAdmetTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildScreenAdmetTool } from "../../../src/tools/builtins/screen_admet.js";

const ADMETLAB_URL = "http://mcp-admetlab:8011";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

const FAKE_RESPONSE = {
  predictions: [
    {
      smiles: "c1ccccc1",
      endpoints: {
        absorption: { Caco2: 18.5, HIA_Hou: 0.99 },
        distribution: { VD: 0.8 },
        metabolism: {},
        excretion: {},
        toxicity: { hERG: "safe" },
      },
      alerts: [],
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("buildScreenAdmetTool", () => {
  it("calls correct URL and returns predictions", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildScreenAdmetTool(ADMETLAB_URL);
    const result = await tool.execute(makeCtx(), { smiles_list: ["c1ccccc1"] });

    expect(result.predictions).toHaveLength(1);
    expect(result.predictions[0].smiles).toBe("c1ccccc1");
    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe(`${ADMETLAB_URL}/screen`);
  });

  it("inputSchema rejects list longer than 50", () => {
    const tool = buildScreenAdmetTool(ADMETLAB_URL);
    expect(
      tool.inputSchema.safeParse({ smiles_list: Array(51).fill("C") }).success,
    ).toBe(false);
  });

  it("inputSchema rejects empty list", () => {
    const tool = buildScreenAdmetTool(ADMETLAB_URL);
    expect(tool.inputSchema.safeParse({ smiles_list: [] }).success).toBe(false);
  });

  it("throws on 503 (service not ready)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "not ready" }),
    );
    const tool = buildScreenAdmetTool(ADMETLAB_URL);
    await expect(
      tool.execute(makeCtx(), { smiles_list: ["C"] }),
    ).rejects.toThrow(/503/);
  });

  it("strips trailing slash from URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildScreenAdmetTool(`${ADMETLAB_URL}/`);
    await tool.execute(makeCtx(), { smiles_list: ["c1ccccc1"] });

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe(`${ADMETLAB_URL}/screen`);
  });
});
