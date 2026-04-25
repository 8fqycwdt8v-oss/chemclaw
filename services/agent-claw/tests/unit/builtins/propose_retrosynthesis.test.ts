// Tests for buildProposeRetrosynthesisTool.
// Covers: ASKCOS success path, ASKCOS timeout fallback to AiZynth,
//         ASKCOS 503 fallback, prefer_aizynth flag, schema validation.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildProposeRetrosynthesisTool,
} from "../../../src/tools/builtins/propose_retrosynthesis.js";

const ASKCOS_URL = "http://mcp-askcos:8007";
const AIZYNTH_URL = "http://mcp-aizynth:8008";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

const FAKE_ASKCOS_RESPONSE = {
  routes: [
    {
      steps: [
        { reaction_smiles: "CC>>C", score: 0.85, sources_count: 2 },
      ],
      total_score: 0.85,
      depth: 1,
    },
  ],
};

const FAKE_AIZYNTH_RESPONSE = {
  routes: [{ tree: { smiles: "CCO" }, score: 0.70, in_stock_ratio: 0.9 }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildProposeRetrosynthesisTool", () => {
  it("returns askcos routes on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify(FAKE_ASKCOS_RESPONSE),
      }),
    );

    const tool = buildProposeRetrosynthesisTool(ASKCOS_URL, AIZYNTH_URL);
    const result = await tool.execute(makeCtx(), { smiles: "CCO", max_depth: 3, max_branches: 4, prefer_aizynth: false });

    expect(result.source).toBe("askcos");
    expect(result.routes_askcos).toHaveLength(1);
    expect(result.routes_askcos![0].depth).toBe(1);
  });

  it("falls back to aizynth when askcos times out", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementationOnce(() => {
        const ctl = new AbortController();
        ctl.abort();
        return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(FAKE_AIZYNTH_RESPONSE),
      });

    vi.stubGlobal("fetch", mockFetch);

    const tool = buildProposeRetrosynthesisTool(ASKCOS_URL, AIZYNTH_URL);
    const result = await tool.execute(makeCtx(), { smiles: "CCO", max_depth: 3, max_branches: 4, prefer_aizynth: false });

    expect(result.source).toBe("aizynth");
    expect(result.fallback_reason).toContain("timed out");
    expect(result.routes_aizynth).toHaveLength(1);
  });

  it("falls back to aizynth when askcos returns 503", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "not ready" })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(FAKE_AIZYNTH_RESPONSE),
      });

    vi.stubGlobal("fetch", mockFetch);

    const tool = buildProposeRetrosynthesisTool(ASKCOS_URL, AIZYNTH_URL);
    const result = await tool.execute(makeCtx(), { smiles: "CCO", max_depth: 3, max_branches: 4, prefer_aizynth: false });

    expect(result.source).toBe("aizynth");
    expect(result.fallback_reason).toContain("503");
  });

  it("uses aizynth directly when prefer_aizynth is true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify(FAKE_AIZYNTH_RESPONSE),
      }),
    );

    const tool = buildProposeRetrosynthesisTool(ASKCOS_URL, AIZYNTH_URL);
    const result = await tool.execute(makeCtx(), { smiles: "CCO", max_depth: 3, max_branches: 4, prefer_aizynth: true });

    expect(result.source).toBe("aizynth");
  });

  it("inputSchema rejects smiles > 10000 chars", () => {
    const tool = buildProposeRetrosynthesisTool(ASKCOS_URL, AIZYNTH_URL);
    const result = tool.inputSchema.safeParse({ smiles: "C".repeat(10_001) });
    expect(result.success).toBe(false);
  });

  it("strips trailing slash from askcos URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_ASKCOS_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildProposeRetrosynthesisTool(ASKCOS_URL + "/", AIZYNTH_URL);
    await tool.execute(makeCtx(), { smiles: "CCO", max_depth: 3, max_branches: 4, prefer_aizynth: false });

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe(`${ASKCOS_URL}/retrosynthesis`);
  });
});
