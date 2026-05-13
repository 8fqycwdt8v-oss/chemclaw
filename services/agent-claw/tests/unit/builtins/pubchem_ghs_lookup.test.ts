// Tests for buildPubchemGhsLookupTool (gap-plan H0.4).
//
// Stubs global `fetch` so the suite is hermetic — no PubChem network call
// at test time. The mcp-rdkit InChIKey-from-SMILES roundtrip uses postJson
// which also goes through `fetch`, so the InChIKey-only input mode lets us
// skip mocking that hop.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildPubchemGhsLookupTool,
  extractGhsFromView,
} from "../../../src/tools/builtins/pubchem_ghs_lookup.js";
import { makeCtx } from "../../helpers/make-ctx.js";

const MCP_RDKIT_URL = "http://mcp-rdkit:8001";

// PubChem InChIKey lookup body shape we depend on.
const cidLookup = (cid: number) => ({ IdentifierList: { CID: [cid] } });

// A synthetic but realistic PUG-View payload mirroring PubChem's deeply
// nested Record.Section[].Section[].Information[].Value.StringWithMarkup[]
// shape. The extractor walks every string leaf so the exact structure
// doesn't matter beyond "string leaves contain H- / GHS- tokens".
const ghsView = (codes: string[], pictograms: string[], signal: string) => ({
  Record: {
    Section: [
      {
        TOCHeading: "Safety and Hazards",
        Section: [
          {
            TOCHeading: "GHS Classification",
            Information: [
              {
                Name: "Pictogram(s)",
                Value: {
                  StringWithMarkup: pictograms.map((p) => ({ String: p })),
                },
              },
              {
                Name: "Signal",
                Value: { StringWithMarkup: [{ String: signal }] },
              },
              {
                Name: "GHS Hazard Statements",
                Value: {
                  StringWithMarkup: codes.map((c) => ({
                    String: `${c}: example hazard text`,
                  })),
                },
              },
            ],
          },
        ],
      },
    ],
  },
});

// Sequenced fetch mock: returns each prepared body in order, ok=true.
function mockFetchSequence(
  bodies: ReadonlyArray<{ status?: number; body: unknown }>,
) {
  let call = 0;
  return vi.fn().mockImplementation(async (): Promise<Response> => {
    const next = bodies[call++];
    if (!next) throw new Error("mockFetchSequence: no more responses");
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    } as unknown as Response;
  });
}

const ACETONE_INCHIKEY = "CSCPPACGZOOCGX-UHFFFAOYSA-N";

// ---------------------------------------------------------------------------
// Pure extractor — no network, no fetch, no schema.
// ---------------------------------------------------------------------------

describe("extractGhsFromView", () => {
  it("harvests hazard codes, pictograms, and signal word", () => {
    const view = ghsView(["H225", "H319", "H336"], ["GHS02", "GHS07"], "Danger");
    const ghs = extractGhsFromView(view);
    expect(ghs.hazard_codes).toEqual(["H225", "H319", "H336"]);
    expect(ghs.pictograms).toEqual(["GHS02", "GHS07"]);
    expect(ghs.signal_word).toBe("Danger");
  });

  it("returns empty arrays when nothing matches", () => {
    const ghs = extractGhsFromView({ Record: { Section: [] } });
    expect(ghs).toEqual({
      hazard_codes: [],
      pictograms: [],
      signal_word: null,
    });
  });

  it("deduplicates repeated codes / pictograms", () => {
    const view = ghsView(["H225", "H225", "H319"], ["GHS02", "GHS02"], "Warning");
    const ghs = extractGhsFromView(view);
    expect(ghs.hazard_codes).toEqual(["H225", "H319"]);
    expect(ghs.pictograms).toEqual(["GHS02"]);
    expect(ghs.signal_word).toBe("Warning");
  });

  it("ignores out-of-range pseudo-codes", () => {
    // H100 / H599 must NOT match (GHS only goes H200-H499).
    const view = ghsView(["H100", "H225", "H599"], [], "Danger");
    const ghs = extractGhsFromView(view);
    expect(ghs.hazard_codes).toEqual(["H225"]);
  });

  it("survives null / arrays / nested objects without throwing", () => {
    const ghs = extractGhsFromView({
      a: null,
      b: [null, undefined, "H225"],
      c: { d: { e: "GHS02" } },
    });
    expect(ghs.hazard_codes).toEqual(["H225"]);
    expect(ghs.pictograms).toEqual(["GHS02"]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end through execute() — uses the InChIKey input path so we don't
// need to mock the mcp-rdkit hop.
// ---------------------------------------------------------------------------

describe("buildPubchemGhsLookupTool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns hazard codes + pictograms + signal word for a known compound", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence([
        { body: cidLookup(180) }, // acetone CID
        { body: ghsView(["H225", "H319", "H336"], ["GHS02", "GHS07"], "Danger") },
      ]),
    );

    const tool = buildPubchemGhsLookupTool(MCP_RDKIT_URL);
    const result = await tool.execute(makeCtx(), {
      inchikey: ACETONE_INCHIKEY,
    });

    expect(result.cid).toBe(180);
    expect(result.inchikey).toBe(ACETONE_INCHIKEY);
    expect(result.hazard_codes).toEqual(["H225", "H319", "H336"]);
    expect(result.pictograms).toEqual(["GHS02", "GHS07"]);
    expect(result.signal_word).toBe("Danger");
    expect(result.has_ghs_data).toBe(true);
    expect(result.source_url).toContain("pubchem.ncbi.nlm.nih.gov");
    expect(result.source_url).toContain("180");
  });

  it("returns has_ghs_data=false (UNKNOWN, not safe) when InChIKey has no CID", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence([{ status: 404, body: {} }]),
    );

    const tool = buildPubchemGhsLookupTool(MCP_RDKIT_URL);
    const result = await tool.execute(makeCtx(), {
      inchikey: "AAAAAAAAAAAAAA-BBBBBBBBBB-N",
    });

    expect(result.cid).toBeNull();
    expect(result.has_ghs_data).toBe(false);
    expect(result.hazard_codes).toEqual([]);
    expect(result.pictograms).toEqual([]);
    expect(result.signal_word).toBeNull();
  });

  it("returns has_ghs_data=false when CID exists but GHS section missing", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence([
        { body: cidLookup(7777) }, // resolves CID
        { status: 404, body: {} }, // GHS view 404 = no GHS section
      ]),
    );

    const tool = buildPubchemGhsLookupTool(MCP_RDKIT_URL);
    const result = await tool.execute(makeCtx(), {
      inchikey: "BBBBBBBBBBBBBB-CCCCCCCCCC-N",
    });

    expect(result.cid).toBe(7777);
    expect(result.has_ghs_data).toBe(false);
    expect(result.hazard_codes).toEqual([]);
  });

  it("rejects input that supplies neither smiles nor inchikey", async () => {
    const tool = buildPubchemGhsLookupTool(MCP_RDKIT_URL);
    await expect(
      // @ts-expect-error - intentionally missing both fields for the test
      tool.execute(makeCtx(), {}),
    ).rejects.toThrow();
  });

  it("rejects malformed InChIKey at the schema layer", async () => {
    const tool = buildPubchemGhsLookupTool(MCP_RDKIT_URL);
    // Schema regex allows only [A-Z]{14}-[A-Z]{10}-[A-Z]
    expect(() =>
      tool.inputSchema.parse({ inchikey: "lowercase-key-N" }),
    ).toThrow();
  });

  it("throws when PubChem returns 5xx for the CID lookup", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence([{ status: 503, body: {} }]),
    );
    const tool = buildPubchemGhsLookupTool(MCP_RDKIT_URL);
    await expect(
      tool.execute(makeCtx(), { inchikey: ACETONE_INCHIKEY }),
    ).rejects.toThrow(/pubchem upstream 503/);
  });
});
