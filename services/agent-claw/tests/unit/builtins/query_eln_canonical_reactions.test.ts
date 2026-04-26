// Tests for buildQueryElnCanonicalReactionsTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildQueryElnCanonicalReactionsTool } from "../../../src/tools/builtins/query_eln_canonical_reactions.js";
import {
  MOCK_ELN_URL,
  makeCtx,
  mockFetchOk,
  mockFetchStatus,
  SAMPLE_REACTION,
} from "./eln_test_helpers.js";

describe("buildQueryElnCanonicalReactionsTool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts to /reactions/query with optional filters", async () => {
    const fetchMock = mockFetchOk({ items: [SAMPLE_REACTION] });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildQueryElnCanonicalReactionsTool(MOCK_ELN_URL);
    const out = await tool.execute(makeCtx(), {
      family: "amide_coupling",
      project_code: "NCE-1234",
      min_ofat_count: 100,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://mcp-eln-local:8013/reactions/query");
    const body = JSON.parse(init.body as string);
    expect(body.family).toBe("amide_coupling");
    expect(body.min_ofat_count).toBe(100);
    expect(out.items[0]?.ofat_count).toBe(120);
  });

  it("default limit applies", async () => {
    const fetchMock = mockFetchOk({ items: [] });
    vi.stubGlobal("fetch", fetchMock);
    const tool = buildQueryElnCanonicalReactionsTool(MOCK_ELN_URL);
    await tool.execute(makeCtx(), {});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.limit).toBe(50);
  });

  it("rejects family with invalid characters", () => {
    const tool = buildQueryElnCanonicalReactionsTool(MOCK_ELN_URL);
    const r = tool.inputSchema.safeParse({ family: "bad family!" });
    expect(r.success).toBe(false);
  });

  it("propagates upstream 503", async () => {
    vi.stubGlobal("fetch", mockFetchStatus(503, "degraded"));
    const tool = buildQueryElnCanonicalReactionsTool(MOCK_ELN_URL);
    await expect(tool.execute(makeCtx(), {})).rejects.toThrow(/503/);
  });
});
