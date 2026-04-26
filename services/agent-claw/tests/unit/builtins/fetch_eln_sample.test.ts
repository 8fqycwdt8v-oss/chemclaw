// Tests for buildFetchElnSampleTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildFetchElnSampleTool } from "../../../src/tools/builtins/fetch_eln_sample.js";
import {
  MOCK_ELN_URL,
  makeCtx,
  mockFetchOk,
  mockFetchStatus,
  SAMPLE_SAMPLE,
  IDS,
} from "./eln_test_helpers.js";

describe("buildFetchElnSampleTool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts to /samples/fetch with sample_id and parses results", async () => {
    const fetchMock = mockFetchOk(SAMPLE_SAMPLE);
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildFetchElnSampleTool(MOCK_ELN_URL);
    const out = await tool.execute(makeCtx(), { sample_id: IDS.sampleA });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://mcp-eln-local:8013/samples/fetch");
    const body = JSON.parse(init.body as string);
    expect(body.sample_id).toBe(IDS.sampleA);
    expect(out.id).toBe(IDS.sampleA);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.metric).toBe("purity_pct");
    expect(out.citation_uri).toMatch(/^local-mock-eln:/);
  });

  it("rejects bad sample_id", () => {
    const tool = buildFetchElnSampleTool(MOCK_ELN_URL);
    const r = tool.inputSchema.safeParse({ sample_id: "" });
    expect(r.success).toBe(false);
  });

  it("propagates 404", async () => {
    vi.stubGlobal("fetch", mockFetchStatus(404));
    const tool = buildFetchElnSampleTool(MOCK_ELN_URL);
    await expect(
      tool.execute(makeCtx(), { sample_id: IDS.sampleA }),
    ).rejects.toThrow(/404/);
  });
});
