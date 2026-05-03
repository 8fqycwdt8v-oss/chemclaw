// Tests for buildQmSinglePointTool — Phase 2 xTB capability surface.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildQmSinglePointTool } from "../../../src/tools/builtins/qm_single_point.js";

const XTB_URL = "http://mcp-xtb:8010";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

const FAKE_RESPONSE = {
  job_id: "11111111-1111-1111-1111-111111111111",
  cache_hit: false,
  status: "succeeded",
  summary: "GFN2 single-point on CCO: E=-5.123 Eh",
  method: "GFN2",
  task: "sp",
  energy_hartree: -5.123,
  homo_lumo_eV: 7.2,
  dipole: [0.0, 0.0, 1.4],
};

afterEach(() => vi.unstubAllGlobals());

describe("buildQmSinglePointTool", () => {
  it("posts payload and returns parsed response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildQmSinglePointTool(XTB_URL);
    const result = await tool.execute(makeCtx(), {
      smiles: "CCO",
      method: "GFN2",
      charge: 0,
      multiplicity: 1,
      solvent_model: "none",
      force_recompute: false,
    });

    expect(result.energy_hartree).toBeCloseTo(-5.123);
    expect(result.cache_hit).toBe(false);
    expect(result.method).toBe("GFN2");
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${XTB_URL}/single_point`);
    const body = JSON.parse(init.body as string) as { method: string; smiles: string };
    expect(body.smiles).toBe("CCO");
    expect(body.method).toBe("GFN2");
  });

  it("accepts every QmMethod the schema declares", () => {
    const tool = buildQmSinglePointTool(XTB_URL);
    for (const m of ["GFN0", "GFN1", "GFN2", "GFN-FF", "g-xTB", "sTDA-xTB", "IPEA-xTB"]) {
      expect(
        tool.inputSchema.safeParse({ smiles: "CCO", method: m }).success,
      ).toBe(true);
    }
  });

  it("rejects unknown methods", () => {
    const tool = buildQmSinglePointTool(XTB_URL);
    expect(
      tool.inputSchema.safeParse({ smiles: "CCO", method: "DFT-B3LYP" }).success,
    ).toBe(false);
  });

  it("inputSchema rejects empty smiles", () => {
    const tool = buildQmSinglePointTool(XTB_URL);
    expect(tool.inputSchema.safeParse({ smiles: "" }).success).toBe(false);
  });

  it("threads force_recompute through", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ...FAKE_RESPONSE, cache_hit: false }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildQmSinglePointTool(XTB_URL);
    await tool.execute(makeCtx(), {
      smiles: "CCO",
      method: "GFN2",
      charge: 0,
      multiplicity: 1,
      solvent_model: "none",
      force_recompute: true,
    });
    const body = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string,
    ) as { force_recompute: boolean };
    expect(body.force_recompute).toBe(true);
  });
});
