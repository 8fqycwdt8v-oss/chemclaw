// Tests for buildRunXtbWorkflowTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildRunXtbWorkflowTool } from "../../../src/tools/builtins/run_xtb_workflow.js";

const XTB_URL = "http://mcp-xtb:8010";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

const FAKE_REACTION_ENERGY = {
  recipe: "reaction_energy",
  success: true,
  steps: [{ name: "opt_both", seconds: 8.4, ok: true }],
  outputs: {
    reactant_energy_hartree: -5.0,
    product_energy_hartree: -5.05,
    delta_e_hartree: -0.05,
    delta_e_kcal_mol: -31.4,
  },
  warnings: [],
  total_seconds: 8.5,
};

afterEach(() => vi.unstubAllGlobals());

describe("buildRunXtbWorkflowTool", () => {
  it("posts to /run_workflow with the recipe + inputs payload", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_REACTION_ENERGY),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildRunXtbWorkflowTool(XTB_URL);
    const result = await tool.execute(makeCtx(), {
      recipe: "reaction_energy",
      inputs: { reactant_smiles: "CCO", product_smiles: "CC=O" },
    });

    expect(result.success).toBe(true);
    expect(result.recipe).toBe("reaction_energy");
    expect(result.outputs.delta_e_hartree).toBeCloseTo(-0.05);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${XTB_URL}/run_workflow`);
    const body = JSON.parse(init.body as string) as {
      recipe: string;
      inputs: Record<string, unknown>;
    };
    expect(body.recipe).toBe("reaction_energy");
    expect(body.inputs).toEqual({ reactant_smiles: "CCO", product_smiles: "CC=O" });
  });

  it("inputSchema rejects an unknown recipe before the network call", () => {
    const tool = buildRunXtbWorkflowTool(XTB_URL);
    const parsed = tool.inputSchema.safeParse({
      recipe: "no_such_recipe",
      inputs: {},
    });
    expect(parsed.success).toBe(false);
  });

  it("inputSchema rejects total_timeout_seconds > 1800", () => {
    const tool = buildRunXtbWorkflowTool(XTB_URL);
    expect(
      tool.inputSchema.safeParse({
        recipe: "reaction_energy",
        inputs: { reactant_smiles: "CCO", product_smiles: "CC=O" },
        total_timeout_seconds: 3600,
      }).success,
    ).toBe(false);
  });

  it("returns success=false body without throwing when the recipe failed", async () => {
    const FAILED = {
      ...FAKE_REACTION_ENERGY,
      success: false,
      steps: [{ name: "opt_both", seconds: 1.1, ok: false, error: "xtb exit 1: ..." }],
      outputs: {},
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(FAILED) }),
    );

    const tool = buildRunXtbWorkflowTool(XTB_URL);
    const result = await tool.execute(makeCtx(), {
      recipe: "reaction_energy",
      inputs: { reactant_smiles: "CCO", product_smiles: "CC=O" },
    });
    expect(result.success).toBe(false);
    expect(result.steps[0].ok).toBe(false);
  });

  it("throws on mcp-xtb 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "unknown recipe" }),
    );
    const tool = buildRunXtbWorkflowTool(XTB_URL);
    await expect(
      tool.execute(makeCtx(), { recipe: "reaction_energy", inputs: {} }),
    ).rejects.toThrow(/400/);
  });

  it("strips trailing slash from URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_REACTION_ENERGY),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildRunXtbWorkflowTool(`${XTB_URL}/`);
    await tool.execute(makeCtx(), {
      recipe: "reaction_energy",
      inputs: { reactant_smiles: "CCO", product_smiles: "CC=O" },
    });

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe(`${XTB_URL}/run_workflow`);
  });
});
