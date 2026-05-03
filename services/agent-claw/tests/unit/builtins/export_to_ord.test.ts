import { describe, it, expect, vi, afterEach } from "vitest";
import { buildExportToOrdTool } from "../../../src/tools/builtins/export_to_ord.js";

const URL_ = "http://mcp-ord-io:8021";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

const FAKE_RESPONSE = {
  ord_protobuf_b64: "AAEC",
  n_reactions: 1,
  summary: { plate_name: "p", n_reactions: 1, bytes: 12 },
};

afterEach(() => vi.unstubAllGlobals());

describe("buildExportToOrdTool", () => {
  it("calls /export and returns base64 protobuf", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildExportToOrdTool(URL_);
    const result = await tool.execute(makeCtx(), {
      plate_name: "p",
      reactants_smiles: "CC",
      product_smiles: "CO",
      wells: [{ well_id: "A01", rxn_smiles: "CC>>CO", factor_values: { t: 80 } }],
    });

    expect(result.ord_protobuf_b64).toBe("AAEC");
    expect(result.n_reactions).toBe(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${URL_}/export`);
  });

  it("rejects empty wells list", () => {
    const tool = buildExportToOrdTool(URL_);
    expect(
      tool.inputSchema.safeParse({ plate_name: "p", wells: [] }).success,
    ).toBe(false);
  });
});
