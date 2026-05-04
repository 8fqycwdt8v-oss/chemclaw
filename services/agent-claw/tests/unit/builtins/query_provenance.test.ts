// Tests for buildQueryProvenanceTool — Tranche 3 / H4.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildQueryProvenanceTool } from "../../../src/tools/builtins/query_provenance.js";
import { makeCtx } from "../../helpers/make-ctx.js";

const MCP_KG_URL = "http://mcp-kg:8003";

const FACT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const VALID_RESPONSE = {
  fact_id: FACT_ID,
  subject: { label: "Compound", id_property: "inchikey", id_value: "KEY1" },
  predicate: "HAS_YIELD",
  object: { label: "YieldMeasurement", id_property: "id", id_value: "ym-1" },
  provenance: {
    source_type: "ELN" as const,
    source_id: "ELN-42",
    extracted_by_agent_run_id: "11111111-1111-1111-1111-111111111111",
  },
  confidence_tier: "multi_source_llm" as const,
  confidence_score: 0.82,
  t_valid_from: "2026-01-01T00:00:00Z",
  t_valid_to: null,
  recorded_at: "2026-01-01T00:00:00Z",
  invalidated_at: null,
  invalidation_reason: null,
};

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify(body),
  });
}

describe("buildQueryProvenanceTool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to /tools/get_fact_provenance", async () => {
    const mockFetch = mockFetchOk(VALID_RESPONSE);
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildQueryProvenanceTool(MCP_KG_URL);
    await tool.execute(makeCtx(), { fact_id: FACT_ID });

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("http://mcp-kg:8003/tools/get_fact_provenance");
  });

  it("returns the structured provenance + bi-temporal envelope", async () => {
    vi.stubGlobal("fetch", mockFetchOk(VALID_RESPONSE));

    const tool = buildQueryProvenanceTool(MCP_KG_URL);
    const result = await tool.execute(makeCtx(), { fact_id: FACT_ID });

    expect(result.fact_id).toBe(FACT_ID);
    expect(result.provenance.source_type).toBe("ELN");
    expect(result.provenance.source_id).toBe("ELN-42");
    expect(result.confidence_tier).toBe("multi_source_llm");
    expect(result.t_valid_from).toBe("2026-01-01T00:00:00Z");
    expect(result.invalidated_at).toBeNull();
  });

  it("forwards group_id when supplied so cross-tenant lookups stay scoped", async () => {
    const mockFetch = mockFetchOk(VALID_RESPONSE);
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildQueryProvenanceTool(MCP_KG_URL);
    await tool.execute(makeCtx(), {
      fact_id: FACT_ID,
      group_id: "proj-NCE-007",
    });

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init).toBeDefined();
    const body = JSON.parse(init.body as string);
    expect(body.group_id).toBe("proj-NCE-007");
  });

  it("propagates 404 from mcp-kg as a tool error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({ error: "not_found", detail: `fact_id ${FACT_ID} not found` }),
      }),
    );

    const tool = buildQueryProvenanceTool(MCP_KG_URL);
    await expect(
      tool.execute(makeCtx(), { fact_id: FACT_ID }),
    ).rejects.toThrow(/404|not.found/i);
  });

  it("inputSchema rejects non-uuid fact_id", () => {
    const tool = buildQueryProvenanceTool(MCP_KG_URL);
    const r = tool.inputSchema.safeParse({ fact_id: "not-a-uuid" });
    expect(r.success).toBe(false);
  });
});
