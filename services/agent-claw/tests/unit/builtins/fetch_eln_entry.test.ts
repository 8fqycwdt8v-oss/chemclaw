// Tests for buildFetchElnEntryTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildFetchElnEntryTool } from "../../../src/tools/builtins/fetch_eln_entry.js";
import {
  MOCK_ELN_URL,
  makeCtx,
  mockFetchOk,
  mockFetchStatus,
  SAMPLE_ENTRY,
  IDS,
} from "./eln_test_helpers.js";

describe("buildFetchElnEntryTool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts to /experiments/fetch with the entry_id", async () => {
    const fetchMock = mockFetchOk(SAMPLE_ENTRY);
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildFetchElnEntryTool(MOCK_ELN_URL);
    const out = await tool.execute(makeCtx(), { entry_id: IDS.entryA });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://mcp-eln-local:8013/experiments/fetch");
    const body = JSON.parse(init.body as string);
    expect(body.entry_id).toBe(IDS.entryA);
    expect(out.id).toBe(IDS.entryA);
    expect(out.citation_uri).toMatch(/^local-mock-eln:/);
  });

  it("rejects an entry_id with bad characters", () => {
    const tool = buildFetchElnEntryTool(MOCK_ELN_URL);
    const r = tool.inputSchema.safeParse({ entry_id: "bad id!" });
    expect(r.success).toBe(false);
  });

  it("propagates 404 from the MCP service", async () => {
    vi.stubGlobal("fetch", mockFetchStatus(404, "not found"));
    const tool = buildFetchElnEntryTool(MOCK_ELN_URL);
    await expect(
      tool.execute(makeCtx(), { entry_id: "definitely-missing" }),
    ).rejects.toThrow(/404/);
  });
});
