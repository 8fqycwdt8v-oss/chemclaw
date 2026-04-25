// Tests for buildCanonicalizeSmilesTool:
//   - fetch is mocked; verify correct URL + request body
//   - Zod validation on response shape
//   - MCP URL trailing-slash handling

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildCanonicalizeSmilesTool } from "../../src/tools/builtins/canonicalize_smiles.js";

const MOCK_RDKIT_URL = "http://mcp-rdkit:8001";

const VALID_RESPONSE = {
  canonical_smiles: "c1ccccc1",
  inchikey: "UHOVQNZJYSORNB-UHFFFAOYSA-N",
  formula: "C6H6",
  mw: 78.11,
};

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify(body),
  } as Response);
}

describe("buildCanonicalizeSmilesTool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the correct URL with the SMILES in the request body", async () => {
    const mockFetch = mockFetchOk(VALID_RESPONSE);
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildCanonicalizeSmilesTool(MOCK_RDKIT_URL);
    const ctx = makeCtx();
    await tool.execute(ctx, { smiles: "c1ccccc1" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://mcp-rdkit:8001/tools/canonicalize_smiles");

    const body = JSON.parse(init.body as string) as { smiles: string };
    expect(body.smiles).toBe("c1ccccc1");
  });

  it("strips a trailing slash from the base URL", async () => {
    const mockFetch = mockFetchOk(VALID_RESPONSE);
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildCanonicalizeSmilesTool("http://mcp-rdkit:8001/");
    await tool.execute(makeCtx(), { smiles: "C" });

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("http://mcp-rdkit:8001/tools/canonicalize_smiles");
  });

  it("passes kekulize flag when provided", async () => {
    const mockFetch = mockFetchOk(VALID_RESPONSE);
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildCanonicalizeSmilesTool(MOCK_RDKIT_URL);
    await tool.execute(makeCtx(), { smiles: "c1ccccc1", kekulize: true });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { kekulize: boolean };
    expect(body.kekulize).toBe(true);
  });

  it("returns the validated response shape from the MCP service", async () => {
    vi.stubGlobal("fetch", mockFetchOk(VALID_RESPONSE));

    const tool = buildCanonicalizeSmilesTool(MOCK_RDKIT_URL);
    const result = await tool.execute(makeCtx(), { smiles: "c1ccccc1" });

    expect(result).toEqual(VALID_RESPONSE);
  });

  it("throws UpstreamError when the MCP service returns a non-OK status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => "invalid SMILES",
      } as unknown as Response),
    );

    const tool = buildCanonicalizeSmilesTool(MOCK_RDKIT_URL);
    await expect(
      tool.execute(makeCtx(), { smiles: "INVALID!!!" }),
    ).rejects.toThrow(/422/);
  });

  it("throws when MCP returns an invalid response shape (Zod validation)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOk({ not_the_right_field: true }),
    );

    const tool = buildCanonicalizeSmilesTool(MOCK_RDKIT_URL);
    await expect(
      tool.execute(makeCtx(), { smiles: "C" }),
    ).rejects.toThrow(/invalid response shape/);
  });

  it("tool inputSchema rejects empty smiles via Zod", () => {
    const tool = buildCanonicalizeSmilesTool(MOCK_RDKIT_URL);
    const result = tool.inputSchema.safeParse({ smiles: "" });
    expect(result.success).toBe(false);
  });

  it("tool inputSchema accepts a valid smiles without kekulize", () => {
    const tool = buildCanonicalizeSmilesTool(MOCK_RDKIT_URL);
    const result = tool.inputSchema.safeParse({ smiles: "CC(=O)O" });
    expect(result.success).toBe(true);
  });
});
