// Tests for buildFetchElnCanonicalReactionTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildFetchElnCanonicalReactionTool } from "../../../src/tools/builtins/fetch_eln_canonical_reaction.js";
import {
  MOCK_ELN_URL,
  makeCtx,
  mockFetchOk,
  mockFetchStatus,
  SAMPLE_REACTION_DETAIL,
  IDS,
} from "./eln_test_helpers.js";

describe("buildFetchElnCanonicalReactionTool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts to /reactions/fetch with reaction_id and top_n_ofat default", async () => {
    const fetchMock = mockFetchOk(SAMPLE_REACTION_DETAIL);
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildFetchElnCanonicalReactionTool(MOCK_ELN_URL);
    const out = await tool.execute(makeCtx(), { reaction_id: IDS.reactionA });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://mcp-eln-local:8013/reactions/fetch");
    const body = JSON.parse(init.body as string);
    expect(body.reaction_id).toBe(IDS.reactionA);
    expect(body.top_n_ofat).toBe(10);
    expect(out.ofat_children).toHaveLength(1);
  });

  it("accepts top_n_ofat=0 (no children)", async () => {
    const fetchMock = mockFetchOk({
      ...SAMPLE_REACTION_DETAIL,
      ofat_children: [],
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildFetchElnCanonicalReactionTool(MOCK_ELN_URL);
    const out = await tool.execute(makeCtx(), {
      reaction_id: IDS.reactionA,
      top_n_ofat: 0,
    });
    expect(out.ofat_children).toHaveLength(0);
  });

  it("rejects bad reaction_id format", () => {
    const tool = buildFetchElnCanonicalReactionTool(MOCK_ELN_URL);
    const r = tool.inputSchema.safeParse({ reaction_id: "spaces are bad" });
    expect(r.success).toBe(false);
  });

  it("propagates 404", async () => {
    vi.stubGlobal("fetch", mockFetchStatus(404));
    const tool = buildFetchElnCanonicalReactionTool(MOCK_ELN_URL);
    await expect(
      tool.execute(makeCtx(), { reaction_id: IDS.reactionA }),
    ).rejects.toThrow(/404/);
  });
});
