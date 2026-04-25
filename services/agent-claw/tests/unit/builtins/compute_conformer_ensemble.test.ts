// Tests for buildComputeConformerEnsembleTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildComputeConformerEnsembleTool } from "../../../src/tools/builtins/compute_conformer_ensemble.js";

const XTB_URL = "http://mcp-xtb:8010";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

const FAKE_RESPONSE = {
  conformers: [
    { xyz: "3\nCCO\nC 0.0 0.0 0.0\nC 1.5 0.0 0.0\nO 2.0 1.2 0.0", energy_hartree: -5.123, weight: 0.85 },
    { xyz: "3\nCCO\nC 0.1 0.0 0.0\nC 1.6 0.0 0.0\nO 2.1 1.2 0.0", energy_hartree: -5.100, weight: 0.15 },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("buildComputeConformerEnsembleTool", () => {
  it("calls correct URL and returns conformers", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildComputeConformerEnsembleTool(XTB_URL);
    const result = await tool.execute(makeCtx(), { smiles: "CCO", n_conformers: 20, method: "GFN2-xTB", optimize_first: true });

    expect(result.conformers).toHaveLength(2);
    expect(result.conformers[0].energy_hartree).toBeCloseTo(-5.123);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${XTB_URL}/conformer_ensemble`);
    const body = JSON.parse(init.body as string) as { n_conformers: number };
    expect(body.n_conformers).toBe(20);
  });

  it("inputSchema rejects n_conformers > 100", () => {
    const tool = buildComputeConformerEnsembleTool(XTB_URL);
    expect(
      tool.inputSchema.safeParse({ smiles: "CCO", n_conformers: 101 }).success,
    ).toBe(false);
  });

  it("inputSchema rejects empty smiles", () => {
    const tool = buildComputeConformerEnsembleTool(XTB_URL);
    expect(tool.inputSchema.safeParse({ smiles: "" }).success).toBe(false);
  });

  it("throws on mcp-xtb failure (400)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "invalid SMILES" }),
    );
    const tool = buildComputeConformerEnsembleTool(XTB_URL);
    await expect(
      tool.execute(makeCtx(), { smiles: "INVALID", n_conformers: 10, method: "GFN2-xTB", optimize_first: true }),
    ).rejects.toThrow(/400/);
  });

  it("strips trailing slash from URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildComputeConformerEnsembleTool(`${XTB_URL}/`);
    await tool.execute(makeCtx(), { smiles: "CCO", n_conformers: 5, method: "GFN-FF", optimize_first: false });

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe(`${XTB_URL}/conformer_ensemble`);
  });
});
