// Tests for buildElucidateMechanismTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildElucidateMechanismTool } from "../../../src/tools/builtins/elucidate_mechanism.js";

const SYNTHEGY_URL = "http://mcp-synthegy-mech:8011";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

// Canonical fake response — modeled on Task #4 (hemiacetal formation) from
// the paper benchmark: 4 elementary moves, mix of ionization + attack.
const FAKE_RESPONSE = {
  moves: [
    {
      from_smiles: "CC=O.CO.[H+]",
      to_smiles: "C[CH]=[O+]H.CO",
      score: 8.5,
      derived_kind: "i" as const,
      derived_atom_x: 2,
      derived_atom_y: 0,
      energy_delta_hartree: null,
    },
    {
      from_smiles: "C[CH]=[O+]H.CO",
      to_smiles: "C[CH]([OH])O[CH3].[H+]",
      score: 7.8,
      derived_kind: "a" as const,
      derived_atom_x: 0,
      derived_atom_y: 3,
      energy_delta_hartree: null,
    },
  ],
  reactants_smiles: "CC=O.CO.[H+]",
  products_smiles: "C[CH]([OH])O[CH3].[H+]",
  total_llm_calls: 196,
  total_nodes_explored: 48,
  prompt_tokens: 392_000,
  completion_tokens: 78_400,
  parse_failures: 0,
  upstream_errors: 0,
  warnings: [],
  truncated: false,
};

afterEach(() => vi.unstubAllGlobals());

describe("buildElucidateMechanismTool", () => {
  it("posts to /elucidate_mechanism with the input body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildElucidateMechanismTool(SYNTHEGY_URL);
    const result = await tool.execute(makeCtx(), {
      reactants_smiles: "CC=O.CO.[H+]",
      products_smiles: "C[CH]([OH])O[CH3].[H+]",
      max_nodes: 50,
      conditions: "acid",
      validate_energies: false,
      model: "executor",
    });

    expect(result.moves).toHaveLength(2);
    expect(result.moves[0].score).toBeCloseTo(8.5);
    expect(result.moves[0].derived_kind).toBe("i");
    expect(result.total_llm_calls).toBe(196);
    expect(result.truncated).toBe(false);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SYNTHEGY_URL}/elucidate_mechanism`);
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.reactants_smiles).toBe("CC=O.CO.[H+]");
    expect(sentBody.products_smiles).toBe("C[CH]([OH])O[CH3].[H+]");
    expect(sentBody.conditions).toBe("acid");
  });

  it("strips trailing slash from URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildElucidateMechanismTool(`${SYNTHEGY_URL}/`);
    await tool.execute(makeCtx(), {
      reactants_smiles: "CC=O",
      products_smiles: "CC=O",
      max_nodes: 1,
      validate_energies: false,
      model: "executor",
    });

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe(`${SYNTHEGY_URL}/elucidate_mechanism`);
  });

  it("inputSchema rejects max_nodes above 400", () => {
    const tool = buildElucidateMechanismTool(SYNTHEGY_URL);
    const result = tool.inputSchema.safeParse({
      reactants_smiles: "CC=O",
      products_smiles: "CCO",
      max_nodes: 500,
    });
    expect(result.success).toBe(false);
  });

  it("inputSchema rejects empty SMILES", () => {
    const tool = buildElucidateMechanismTool(SYNTHEGY_URL);
    const result = tool.inputSchema.safeParse({
      reactants_smiles: "",
      products_smiles: "CCO",
    });
    expect(result.success).toBe(false);
  });

  it("inputSchema accepts optional guidance_prompt and conditions", () => {
    const tool = buildElucidateMechanismTool(SYNTHEGY_URL);
    const result = tool.inputSchema.safeParse({
      reactants_smiles: "CC=O.CO",
      products_smiles: "CC(O)OC",
      conditions: "acid catalysis, dilute HCl",
      guidance_prompt: "Form the hemiacetal first via protonation of the carbonyl",
      max_nodes: 100,
    });
    expect(result.success).toBe(true);
  });

  it("inputSchema rejects an unknown model alias", () => {
    const tool = buildElucidateMechanismTool(SYNTHEGY_URL);
    const result = tool.inputSchema.safeParse({
      reactants_smiles: "CC=O",
      products_smiles: "CCO",
      model: "fake-model-9000",
    });
    expect(result.success).toBe(false);
  });

  it("outputSchema accepts the truncated path with empty moves", async () => {
    const truncatedResponse = {
      ...FAKE_RESPONSE,
      moves: [],
      truncated: true,
      warnings: ["Search budget exhausted after 200 nodes without reaching the product."],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify(truncatedResponse),
      }),
    );
    const tool = buildElucidateMechanismTool(SYNTHEGY_URL);
    const result = await tool.execute(makeCtx(), {
      reactants_smiles: "CC=O",
      products_smiles: "CCN",
      max_nodes: 200,
      validate_energies: false,
      model: "executor",
    });
    expect(result.truncated).toBe(true);
    expect(result.moves).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("propagates upstream 503 as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "not ready" }),
    );
    const tool = buildElucidateMechanismTool(SYNTHEGY_URL);
    await expect(
      tool.execute(makeCtx(), {
        reactants_smiles: "CC=O",
        products_smiles: "CCO",
        max_nodes: 10,
        validate_energies: false,
        model: "executor",
      }),
    ).rejects.toThrow(/503/);
  });

  it("is marked readOnly so it joins parallel readonly batches", () => {
    const tool = buildElucidateMechanismTool(SYNTHEGY_URL);
    expect(tool.annotations?.readOnly).toBe(true);
  });
});
