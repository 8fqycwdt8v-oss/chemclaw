import { describe, it, expect, vi, afterEach } from "vitest";
import { buildDesignPlateTool } from "../../../src/tools/builtins/design_plate.js";

const PLATE_URL = "http://mcp-plate-designer:8020";
const YIELD_URL = "http://mcp-yield-baseline:8015";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

const PLATE_RESPONSE = {
  wells: [
    {
      well_id: "A01",
      rxn_smiles: "CC>>CO",
      factor_values: { temperature_c: 80, solvent: "EtOH" },
    },
    {
      well_id: "A02",
      rxn_smiles: "CC>>CO",
      factor_values: { temperature_c: 60, solvent: "Toluene" },
    },
  ],
  domain_json: { type: "Domain" },
  design_metadata: {
    n_wells: 2,
    plate_format: "24",
    rows: 4,
    cols: 6,
    sampling_strategy: "space_filling",
    seed: 42,
    excluded_solvents: [],
    applied_chem21_floor: {},
    disable_chem21_floor: false,
  },
};

const YIELD_RESPONSE = {
  predictions: [
    {
      rxn_smiles: "CC>>CO",
      ensemble_mean: 65,
      ensemble_std: 7,
      components: { chemprop_mean: 60, chemprop_std: 5, xgboost_mean: 70 },
      used_global_fallback: false,
      model_id: "PRJ-001@abc",
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("buildDesignPlateTool", () => {
  it("happy path without annotation", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(PLATE_RESPONSE),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildDesignPlateTool(PLATE_URL, YIELD_URL);
    const result = await tool.execute(makeCtx(), {
      plate_format: "24",
      reactants_smiles: "CC",
      product_smiles: "CO",
      factors: [{ name: "temperature_c", type: "continuous", range: [25, 100] }],
      categorical_inputs: [{ name: "solvent", values: ["EtOH", "Toluene"] }],
      exclusions: { solvents: [], reagents: [] },
      n_wells: 2,
      seed: 42,
      annotate_yield: false,
      disable_chem21_floor: false,
    });

    expect(result.wells).toHaveLength(2);
    expect(result.yield_summary).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("annotates with yield prediction when annotate_yield=true", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(PLATE_RESPONSE),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(YIELD_RESPONSE),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildDesignPlateTool(PLATE_URL, YIELD_URL);
    const result = await tool.execute(makeCtx(), {
      plate_format: "24",
      reactants_smiles: "CC",
      product_smiles: "CO",
      factors: [{ name: "temperature_c", type: "continuous", range: [25, 100] }],
      categorical_inputs: [{ name: "solvent", values: ["EtOH", "Toluene"] }],
      exclusions: { solvents: [], reagents: [] },
      n_wells: 2,
      seed: 42,
      annotate_yield: true,
      disable_chem21_floor: false,
    });

    expect(result.yield_summary?.ensemble_mean).toBe(65);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("yield service failure → still returns plate with null yield_summary", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(PLATE_RESPONSE),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "yield down",
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildDesignPlateTool(PLATE_URL, YIELD_URL);
    const result = await tool.execute(makeCtx(), {
      plate_format: "24",
      reactants_smiles: "CC",
      product_smiles: "CO",
      factors: [{ name: "t", type: "continuous", range: [0, 1] }],
      categorical_inputs: [],
      exclusions: { solvents: [], reagents: [] },
      n_wells: 2,
      seed: 0,
      annotate_yield: true,
      disable_chem21_floor: false,
    });

    expect(result.wells).toHaveLength(2);
    expect(result.yield_summary).toBeNull();
  });

  it("inputSchema rejects n_wells=0", () => {
    const tool = buildDesignPlateTool(PLATE_URL, YIELD_URL);
    expect(
      tool.inputSchema.safeParse({
        plate_format: "24",
        n_wells: 0,
      }).success,
    ).toBe(false);
  });

  it("inputSchema rejects n_wells > plate_format capacity", () => {
    const tool = buildDesignPlateTool(PLATE_URL, YIELD_URL);
    const result = tool.inputSchema.safeParse({
      plate_format: "24",
      n_wells: 100,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/exceeds plate_format=24 capacity 24/);
    }
  });

  it("inputSchema accepts n_wells equal to plate_format capacity", () => {
    const tool = buildDesignPlateTool(PLATE_URL, YIELD_URL);
    expect(
      tool.inputSchema.safeParse({
        plate_format: "96",
        n_wells: 96,
      }).success,
    ).toBe(true);
  });
});
