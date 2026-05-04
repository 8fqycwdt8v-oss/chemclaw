// Tests for buildQueryKgAtTimeTool — Tranche 4 / H3.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildQueryKgAtTimeTool } from "../../../src/tools/builtins/query_kg_at_time.js";
import { makeCtx } from "../../helpers/make-ctx.js";

const MCP_KG_URL = "http://mcp-kg:8003";

const VALID_FACT = {
  fact_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  subject: { label: "Compound", id_property: "inchikey", id_value: "KEY1" },
  predicate: "HAS_YIELD",
  object: { label: "YieldMeasurement", id_property: "id", id_value: "ym-1" },
  edge_properties: { value: 80 },
  confidence_tier: "multi_source_llm" as const,
  confidence_score: 0.82,
  t_valid_from: "2025-06-01T00:00:00Z",
  t_valid_to: "2026-02-15T00:00:00Z",
  recorded_at: "2025-06-01T00:00:00Z",
  provenance: { source_type: "ELN", source_id: "ELN-1" },
};

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify(body),
  });
}

describe("buildQueryKgAtTimeTool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to /tools/query_at_time", async () => {
    const mockFetch = mockFetchOk({ facts: [VALID_FACT] });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildQueryKgAtTimeTool(MCP_KG_URL);
    await tool.execute(makeCtx(), {
      entity: { label: "Compound", id_property: "inchikey", id_value: "KEY1" },
      at_time: "2025-12-01T00:00:00Z",
      direction: "both",
      include_invalidated: false,
    });

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("http://mcp-kg:8003/tools/query_at_time");
  });

  it("forwards the at_time parameter to the server", async () => {
    const mockFetch = mockFetchOk({ facts: [] });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildQueryKgAtTimeTool(MCP_KG_URL);
    await tool.execute(makeCtx(), {
      entity: { label: "Compound", id_property: "inchikey", id_value: "K" },
      at_time: "2025-12-01T00:00:00Z",
      direction: "both",
      include_invalidated: false,
    });

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.at_time).toBe("2025-12-01T00:00:00Z");
  });

  it("inputSchema rejects requests without at_time", () => {
    const tool = buildQueryKgAtTimeTool(MCP_KG_URL);
    const r = tool.inputSchema.safeParse({
      entity: { label: "Compound", id_property: "inchikey", id_value: "K" },
      direction: "both",
      include_invalidated: false,
      // at_time missing — required by this tool
    });
    expect(r.success).toBe(false);
  });

  it("inputSchema rejects non-ISO-8601 at_time", () => {
    const tool = buildQueryKgAtTimeTool(MCP_KG_URL);
    const r = tool.inputSchema.safeParse({
      entity: { label: "Compound", id_property: "inchikey", id_value: "K" },
      at_time: "2025-12-01", // missing time + offset
      direction: "both",
      include_invalidated: false,
    });
    expect(r.success).toBe(false);
  });

  it("returns the validated facts array", async () => {
    vi.stubGlobal("fetch", mockFetchOk({ facts: [VALID_FACT] }));
    const tool = buildQueryKgAtTimeTool(MCP_KG_URL);
    const result = await tool.execute(makeCtx(), {
      entity: { label: "Compound", id_property: "inchikey", id_value: "KEY1" },
      at_time: "2025-12-01T00:00:00Z",
      direction: "both",
      include_invalidated: false,
    });
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.fact_id).toBe(VALID_FACT.fact_id);
  });
});
