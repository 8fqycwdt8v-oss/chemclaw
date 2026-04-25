// Tests for buildQueryKgTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildQueryKgTool } from "../../../src/tools/builtins/query_kg.js";
import { makeCtx } from "../../helpers/make-ctx.js";

const MCP_KG_URL = "http://mcp-kg:8003";

const VALID_FACT = {
  fact_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  subject: { label: "Compound", id_property: "id", id_value: "cpd-001" },
  predicate: "HAS_YIELD",
  object: { label: "YieldMeasurement", id_property: "id", id_value: "ym-001" },
  edge_properties: { value: 85.2 },
  confidence_tier: "multi_source_llm" as const,
  confidence_score: 0.82,
  t_valid_from: "2025-01-01T00:00:00Z",
  t_valid_to: null,
  recorded_at: "2025-01-01T00:00:00Z",
  provenance: { source_type: "eln", source_id: "exp-001" },
};

const VALID_RESPONSE = { facts: [VALID_FACT] };

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify(body),
  } as Response);
}

describe("buildQueryKgTool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to the correct KG endpoint", async () => {
    const mockFetch = mockFetchOk(VALID_RESPONSE);
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildQueryKgTool(MCP_KG_URL);
    const ctx = makeCtx();
    await tool.execute(ctx, {
      entity: { label: "Compound", id_property: "id", id_value: "cpd-001" },
      direction: "out",
      include_invalidated: false,
    });

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("http://mcp-kg:8003/tools/query_at_time");
  });

  it("returns the validated facts array on success", async () => {
    vi.stubGlobal("fetch", mockFetchOk(VALID_RESPONSE));
    const tool = buildQueryKgTool(MCP_KG_URL);
    const result = await tool.execute(makeCtx(), {
      entity: { label: "Compound", id_property: "id", id_value: "cpd-001" },
      direction: "both",
      include_invalidated: false,
    });
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.fact_id).toBe(VALID_FACT.fact_id);
  });

  it("throws UpstreamError when mcp-kg returns non-OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "service unavailable",
      } as unknown as Response),
    );
    const tool = buildQueryKgTool(MCP_KG_URL);
    await expect(
      tool.execute(makeCtx(), {
        entity: { label: "Compound", id_property: "id", id_value: "x" },
        direction: "out",
        include_invalidated: false,
      }),
    ).rejects.toThrow(/503/);
  });

  it("inputSchema rejects entity label that starts with lowercase", () => {
    const tool = buildQueryKgTool(MCP_KG_URL);
    const r = tool.inputSchema.safeParse({
      entity: { label: "compound", id_property: "id", id_value: "x" },
      direction: "out",
      include_invalidated: false,
    });
    expect(r.success).toBe(false);
  });

  it("strips trailing slash from base URL", async () => {
    const mockFetch = mockFetchOk(VALID_RESPONSE);
    vi.stubGlobal("fetch", mockFetch);
    const tool = buildQueryKgTool("http://mcp-kg:8003/");
    await tool.execute(makeCtx(), {
      entity: { label: "Compound", id_property: "id", id_value: "x" },
      direction: "out",
      include_invalidated: false,
    });
    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("http://mcp-kg:8003/tools/query_at_time");
  });
});
