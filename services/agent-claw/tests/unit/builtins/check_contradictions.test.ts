// Tests for buildCheckContradictionsTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildCheckContradictionsTool } from "../../../src/tools/builtins/check_contradictions.js";
import { makeCtx } from "../../helpers/make-ctx.js";

const MCP_KG_URL = "http://mcp-kg:8003";

const FACT_A = {
  fact_id: "aaaaaaaa-0000-0000-0000-000000000001",
  subject: { label: "Reaction", id_property: "id", id_value: "rxn-1" },
  predicate: "HAS_YIELD",
  object: { label: "YieldMeasurement", id_property: "id", id_value: "ym-1" },
  edge_properties: { value: 80 },
  confidence_tier: "multi_source_llm",
  confidence_score: 0.8,
  t_valid_from: "2025-01-01T00:00:00Z",
  t_valid_to: null,
  recorded_at: "2025-01-01T00:00:00Z",
  provenance: { source_type: "eln", source_id: "e1" },
};

const FACT_B = {
  ...FACT_A,
  fact_id: "aaaaaaaa-0000-0000-0000-000000000002",
  object: { label: "YieldMeasurement", id_property: "id", id_value: "ym-2" },
  edge_properties: { value: 60 },
};

function mockFetchSequence(bodies: unknown[]) {
  let call = 0;
  return vi.fn().mockImplementation(async () => {
    const body = bodies[call++] ?? { facts: [] };
    return {
      ok: true,
      text: async () => JSON.stringify(body),
    } as Response;
  });
}

describe("buildCheckContradictionsTool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("detects parallel current facts with different objects", async () => {
    // First call: current outbound facts (A and B both present)
    // Second call: CONTRADICTS edges (empty)
    vi.stubGlobal(
      "fetch",
      mockFetchSequence([{ facts: [FACT_A, FACT_B] }, { facts: [] }]),
    );

    const tool = buildCheckContradictionsTool(MCP_KG_URL);
    const result = await tool.execute(makeCtx(), {
      entity: { label: "Reaction", id_property: "id", id_value: "rxn-1" },
    });

    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0]?.kind).toBe("parallel_current_facts");
    expect(result.surfaced_fact_ids).toContain(FACT_A.fact_id);
    expect(result.surfaced_fact_ids).toContain(FACT_B.fact_id);
  });

  it("surfaces explicit CONTRADICTS edges", async () => {
    const contradictsFact = {
      ...FACT_A,
      predicate: "CONTRADICTS",
      fact_id: "aaaaaaaa-0000-0000-0000-000000000099",
    };
    // current: no parallel facts; contradicts: one edge
    vi.stubGlobal(
      "fetch",
      mockFetchSequence([{ facts: [] }, { facts: [contradictsFact] }]),
    );

    const tool = buildCheckContradictionsTool(MCP_KG_URL);
    const result = await tool.execute(makeCtx(), {
      entity: { label: "Reaction", id_property: "id", id_value: "rxn-1" },
    });

    expect(result.contradictions[0]?.kind).toBe("explicit_contradicts_edge");
    expect(result.surfaced_fact_ids).toContain(contradictsFact.fact_id);
  });

  it("returns empty contradictions when no conflicts found", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence([{ facts: [FACT_A] }, { facts: [] }]),
    );

    const tool = buildCheckContradictionsTool(MCP_KG_URL);
    const result = await tool.execute(makeCtx(), {
      entity: { label: "Reaction", id_property: "id", id_value: "rxn-1" },
    });

    expect(result.contradictions).toHaveLength(0);
  });

  it("inputSchema rejects entity label starting with lowercase", () => {
    const tool = buildCheckContradictionsTool(MCP_KG_URL);
    const r = tool.inputSchema.safeParse({
      entity: { label: "reaction", id_property: "id", id_value: "x" },
    });
    expect(r.success).toBe(false);
  });
});
