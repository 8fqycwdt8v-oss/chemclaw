// Tests for buildQueryElnExperimentsTool.
// Stubs fetch with canned mcp-eln-local responses.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildQueryElnExperimentsTool } from "../../../src/tools/builtins/query_eln_experiments.js";
import {
  MOCK_ELN_URL,
  makeCtx,
  mockFetchOk,
  mockFetchStatus,
  SAMPLE_ENTRY,
} from "./eln_test_helpers.js";

describe("buildQueryElnExperimentsTool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts to /experiments/query with the project_code and parsed defaults", async () => {
    const fetchMock = mockFetchOk({ items: [SAMPLE_ENTRY], next_cursor: null });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildQueryElnExperimentsTool(MOCK_ELN_URL);
    const out = await tool.execute(makeCtx(), { project_code: "NCE-1234" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://mcp-eln-local:8013/experiments/query");
    const body = JSON.parse(init.body as string);
    expect(body.project_code).toBe("NCE-1234");
    expect(body.limit).toBe(50);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.citation_uri).toMatch(/^local-mock-eln:/);
  });

  it("strips a trailing slash from the base URL", async () => {
    const fetchMock = mockFetchOk({ items: [], next_cursor: null });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildQueryElnExperimentsTool(`${MOCK_ELN_URL}/`);
    await tool.execute(makeCtx(), { project_code: "NCE-1234" });
    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("http://mcp-eln-local:8013/experiments/query");
  });

  it("rejects an invalid project_code via Zod", () => {
    const tool = buildQueryElnExperimentsTool(MOCK_ELN_URL);
    const r = tool.inputSchema.safeParse({ project_code: "BAD CODE!" });
    expect(r.success).toBe(false);
  });

  it("rejects entry_shape outside the enum", () => {
    const tool = buildQueryElnExperimentsTool(MOCK_ELN_URL);
    const r = tool.inputSchema.safeParse({
      project_code: "NCE-1234",
      entry_shape: "garbage",
    });
    expect(r.success).toBe(false);
  });

  it("propagates UpstreamError on non-OK response", async () => {
    vi.stubGlobal("fetch", mockFetchStatus(500, "boom"));
    const tool = buildQueryElnExperimentsTool(MOCK_ELN_URL);
    await expect(
      tool.execute(makeCtx(), { project_code: "NCE-1234" }),
    ).rejects.toThrow(/500/);
  });
});
