// Tests for buildQuerySourceCacheTool — Tranche 5 / M1.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildQuerySourceCacheTool } from "../../../src/tools/builtins/query_source_cache.js";
import { makeCtx } from "../../helpers/make-ctx.js";

const MCP_KG_URL = "http://mcp-kg:8003";

const VALID_FACT = {
  fact_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  subject: { label: "SourceEntity", id_property: "source_entity_id", id_value: "eln_local:EXP-007" },
  predicate: "HAS_YIELD",
  object: { label: "LiteralFact", id_property: "literal_id", id_value: "HAS_YIELD:0.85" },
  edge_properties: {
    source_system_id: "eln_local",
    valid_until: "2026-05-11T00:00:00Z",
    fetched_at: "2026-05-04T00:00:00Z",
  },
  confidence_tier: "single_source_llm",
  confidence_score: 0.8,
  t_valid_from: "2026-05-04T00:00:00Z",
  t_valid_to: null,
  recorded_at: "2026-05-04T00:00:00Z",
  provenance: { source_type: "source_system", source_id: "eln_local:EXP-007" },
};

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify(body),
  });
}

describe("buildQuerySourceCacheTool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to /tools/query_at_time with the SourceEntity composite id", async () => {
    const mockFetch = mockFetchOk({ facts: [VALID_FACT] });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildQuerySourceCacheTool(MCP_KG_URL);
    await tool.execute(makeCtx(), {
      source_system_id: "eln_local",
      subject_id: "EXP-007",
    });

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init).toBeDefined();
    const body = JSON.parse(init.body as string);
    expect(body.entity.label).toBe("SourceEntity");
    expect(body.entity.id_property).toBe("source_entity_id");
    expect(body.entity.id_value).toBe("eln_local:EXP-007");
    expect(body.direction).toBe("out");
    expect(body.include_invalidated).toBe(false);
  });

  it("forwards the predicate filter when supplied", async () => {
    const mockFetch = mockFetchOk({ facts: [] });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildQuerySourceCacheTool(MCP_KG_URL);
    await tool.execute(makeCtx(), {
      source_system_id: "eln_local",
      subject_id: "EXP-007",
      predicate: "HAS_YIELD",
    });

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.predicate).toBe("HAS_YIELD");
  });

  it("returns the facts plus the composite source_entity_id", async () => {
    vi.stubGlobal("fetch", mockFetchOk({ facts: [VALID_FACT] }));

    const tool = buildQuerySourceCacheTool(MCP_KG_URL);
    const result = await tool.execute(makeCtx(), {
      source_system_id: "eln_local",
      subject_id: "EXP-007",
    });

    expect(result.source_entity_id).toBe("eln_local:EXP-007");
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.fact_id).toBe(VALID_FACT.fact_id);
    expect(result.facts[0]?.edge_properties.valid_until).toBe(
      "2026-05-11T00:00:00Z",
    );
  });

  it("forwards group_id when supplied so cross-tenant cache reads stay scoped", async () => {
    const mockFetch = mockFetchOk({ facts: [] });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildQuerySourceCacheTool(MCP_KG_URL);
    await tool.execute(makeCtx(), {
      source_system_id: "eln_local",
      subject_id: "EXP-007",
      group_id: "proj-NCE-007",
    });

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.group_id).toBe("proj-NCE-007");
  });

  it("inputSchema rejects empty source_system_id or subject_id", () => {
    const tool = buildQuerySourceCacheTool(MCP_KG_URL);
    expect(
      tool.inputSchema.safeParse({ source_system_id: "", subject_id: "x" })
        .success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({ source_system_id: "x", subject_id: "" })
        .success,
    ).toBe(false);
  });

  it("inputSchema rejects predicates with lowercase characters", () => {
    const tool = buildQuerySourceCacheTool(MCP_KG_URL);
    const r = tool.inputSchema.safeParse({
      source_system_id: "eln_local",
      subject_id: "EXP-007",
      predicate: "has_yield",
    });
    expect(r.success).toBe(false);
  });
});
