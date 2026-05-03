// Tests for buildComputeConformerEnsembleTool — now a thin shim over the
// /run_workflow endpoint (recipe="optimize_ensemble").

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildComputeConformerEnsembleTool } from "../../../src/tools/builtins/compute_conformer_ensemble.js";

const XTB_URL = "http://mcp-xtb:8010";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

const FAKE_SUCCESS = {
  recipe: "optimize_ensemble",
  success: true,
  steps: [
    { name: "embed", seconds: 0.1, ok: true },
    { name: "crest", seconds: 1.2, ok: true },
    { name: "parse", seconds: 0.01, ok: true },
    { name: "opt", seconds: 5.0, ok: true },
    { name: "boltzmann", seconds: 0.001, ok: true },
  ],
  outputs: {
    conformers: [
      { xyz: "3\nCCO\nC 0 0 0\nC 1.5 0 0\nO 2 1.2 0", energy_hartree: -5.123, weight: 0.85 },
      { xyz: "3\nCCO\nC 0.1 0 0\nC 1.6 0 0\nO 2.1 1.2 0", energy_hartree: -5.100, weight: 0.15 },
    ],
  },
  warnings: [],
  total_seconds: 6.4,
};

const FAKE_FAILURE = {
  recipe: "optimize_ensemble",
  success: false,
  steps: [
    { name: "embed", seconds: 0.05, ok: true },
    { name: "crest", seconds: 0.5, ok: false, error: "crest exit 2: ..." },
  ],
  outputs: {},
  warnings: [],
  total_seconds: 0.6,
};

afterEach(() => vi.unstubAllGlobals());

describe("buildComputeConformerEnsembleTool", () => {
  it("posts to /run_workflow with recipe=optimize_ensemble and projects to legacy shape", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_SUCCESS),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildComputeConformerEnsembleTool(XTB_URL);
    const result = await tool.execute(
      makeCtx(),
      { smiles: "CCO", n_conformers: 20, method: "GFN2-xTB", optimize_first: true },
    );

    expect(result.conformers).toHaveLength(2);
    expect(result.conformers[0].energy_hartree).toBeCloseTo(-5.123);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${XTB_URL}/run_workflow`);
    const body = JSON.parse(init.body as string) as {
      recipe: string;
      inputs: { smiles: string; n_conformers: number; method: string };
    };
    expect(body.recipe).toBe("optimize_ensemble");
    expect(body.inputs.smiles).toBe("CCO");
    expect(body.inputs.n_conformers).toBe(20);
    expect(body.inputs.method).toBe("GFN2-xTB");
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

  it("throws when the workflow reports success=false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(FAKE_FAILURE) }),
    );
    const tool = buildComputeConformerEnsembleTool(XTB_URL);
    await expect(
      tool.execute(makeCtx(), { smiles: "CCO", n_conformers: 10, method: "GFN2-xTB", optimize_first: true }),
    ).rejects.toThrow(/crest/);
  });

  it("throws on mcp-xtb 4xx", async () => {
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
      text: async () => JSON.stringify(FAKE_SUCCESS),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildComputeConformerEnsembleTool(`${XTB_URL}/`);
    await tool.execute(
      makeCtx(),
      { smiles: "CCO", n_conformers: 5, method: "GFN-FF", optimize_first: false },
    );

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe(`${XTB_URL}/run_workflow`);
  });
});
