// Tests for buildIdentifyUnknownFromMsTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildIdentifyUnknownFromMsTool } from "../../../src/tools/builtins/identify_unknown_from_ms.js";

const SIRIUS_URL = "http://mcp-sirius:8012";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

const FAKE_PEAKS = [
  { m_z: 100.0, intensity: 1000.0 },
  { m_z: 150.5, intensity: 500.0 },
];

const FAKE_RESPONSE = {
  candidates: [
    {
      smiles: "CC(=O)Oc1ccccc1C(=O)O",
      name: "C9H8O4",
      score: -0.12,
      classyfire: {
        kingdom: "Organic compounds",
        superclass: "Benzenoids",
        class: "Benzene and substituted derivatives",
      },
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("buildIdentifyUnknownFromMsTool", () => {
  it("calls correct URL and returns candidates", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildIdentifyUnknownFromMsTool(SIRIUS_URL);
    const result = await tool.execute(makeCtx(), {
      ms2_peaks: FAKE_PEAKS,
      precursor_mz: 200.5,
      ionization: "positive",
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].smiles).toBe("CC(=O)Oc1ccccc1C(=O)O");
    expect(result.citation?.source_kind).toBe("external_url");

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe(`${SIRIUS_URL}/identify`);
  });

  it("inputSchema rejects precursor_mz of 0", () => {
    const tool = buildIdentifyUnknownFromMsTool(SIRIUS_URL);
    expect(
      tool.inputSchema.safeParse({
        ms2_peaks: FAKE_PEAKS,
        precursor_mz: 0,
        ionization: "positive",
      }).success,
    ).toBe(false);
  });

  it("inputSchema rejects invalid ionization", () => {
    const tool = buildIdentifyUnknownFromMsTool(SIRIUS_URL);
    expect(
      tool.inputSchema.safeParse({
        ms2_peaks: FAKE_PEAKS,
        precursor_mz: 200.5,
        ionization: "neutral",
      }).success,
    ).toBe(false);
  });

  it("inputSchema rejects empty peak list", () => {
    const tool = buildIdentifyUnknownFromMsTool(SIRIUS_URL);
    expect(
      tool.inputSchema.safeParse({ ms2_peaks: [], precursor_mz: 200.5 }).success,
    ).toBe(false);
  });

  it("throws on sirius failure (400)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "sirius failed" }),
    );
    const tool = buildIdentifyUnknownFromMsTool(SIRIUS_URL);
    await expect(
      tool.execute(makeCtx(), { ms2_peaks: FAKE_PEAKS, precursor_mz: 200.5, ionization: "negative" }),
    ).rejects.toThrow(/400/);
  });

  it("returns no citation when candidate list is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ candidates: [] }),
      }),
    );

    const tool = buildIdentifyUnknownFromMsTool(SIRIUS_URL);
    const result = await tool.execute(makeCtx(), {
      ms2_peaks: FAKE_PEAKS,
      precursor_mz: 200.5,
    });
    expect(result.citation).toBeUndefined();
  });
});
