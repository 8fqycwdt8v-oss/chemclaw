// Tests for buildExpandReactionContextTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildExpandReactionContextTool } from "../../../src/tools/builtins/expand_reaction_context.js";
import { mockPool } from "../../helpers/mock-pg.js";
import { makeCtx } from "../../helpers/make-ctx.js";

const MCP_KG_URL = "http://mcp-kg:8003";
const REACTION_UUID = "aaaaaaaa-1111-2222-3333-444444444444";

const CORE_ROW = {
  reaction_id: REACTION_UUID,
  rxn_smiles: "CC>>CCC",
  rxno_class: "C-C coupling",
  experiment_id: "bbbbbbbb-1111-2222-3333-444444444444",
  project_internal_id: "NCE-0042",
  yield_pct: "85.2",
  outcome_status: "success",
  temp_c: "80",
  time_min: "120",
  solvent: "DCM",
};

const KG_OUTCOME_FACT = {
  fact_id: "ffffffff-0000-0000-0000-000000000001",
  subject: { label: "Reaction", id_property: "id", id_value: REACTION_UUID },
  predicate: "HAS_OUTCOME",
  object: { label: "Outcome", id_property: "id", id_value: "out-1" },
  edge_properties: { metric_name: "yield_pct", value: 85.2, unit: "%" },
  confidence_tier: "multi_source_llm",
  confidence_score: 0.9,
  t_valid_from: "2025-01-01T00:00:00Z",
  t_valid_to: null,
  recorded_at: "2025-01-01T00:00:00Z",
  provenance: { source_type: "eln", source_id: "e1" },
};

function mockFetchKg(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify(body),
  });
}

describe("buildExpandReactionContextTool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns core reaction row and conditions on success", async () => {
    vi.stubGlobal("fetch", mockFetchKg({ facts: [] }));

    const { pool, client } = mockPool();
    client.queryResults.push(
      { rows: [], rowCount: 0 }, // BEGIN (core)
      { rows: [], rowCount: 0 }, // set_config
      { rows: [CORE_ROW], rowCount: 1 }, // core reaction query
      { rows: [], rowCount: 0 }, // COMMIT
    );

    const tool = buildExpandReactionContextTool(pool, MCP_KG_URL);
    const result = await tool.execute(makeCtx(), {
      reaction_id: REACTION_UUID,
      include: ["conditions"],
    });

    expect(result.reaction.reaction_id).toBe(REACTION_UUID);
    expect(result.conditions?.solvent).toBe("DCM");
    expect(result.conditions?.temp_c).toBe(80);
    expect(result.surfaced_fact_ids).toHaveLength(0);
  });

  it("throws when reaction not found (RLS block)", async () => {
    vi.stubGlobal("fetch", mockFetchKg({ facts: [] }));

    const { pool, client } = mockPool();
    client.queryResults.push(
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [], rowCount: 0 }, // set_config
      { rows: [], rowCount: 0 }, // empty result
      { rows: [], rowCount: 0 }, // ROLLBACK
    );

    const tool = buildExpandReactionContextTool(pool, MCP_KG_URL);
    await expect(
      tool.execute(makeCtx(), {
        reaction_id: REACTION_UUID,
        include: ["conditions"],
      }),
    ).rejects.toThrow(/not found or not accessible/);
  });

  it("populates surfaced_fact_ids from KG outcomes", async () => {
    vi.stubGlobal("fetch", mockFetchKg({ facts: [KG_OUTCOME_FACT] }));

    const { pool, client } = mockPool();
    client.queryResults.push(
      { rows: [], rowCount: 0 }, // BEGIN (core)
      { rows: [], rowCount: 0 }, // set_config
      { rows: [CORE_ROW], rowCount: 1 }, // core reaction
      { rows: [], rowCount: 0 }, // COMMIT
    );

    const tool = buildExpandReactionContextTool(pool, MCP_KG_URL);
    const result = await tool.execute(makeCtx(), {
      reaction_id: REACTION_UUID,
      include: ["outcomes"],
    });

    expect(result.outcomes).toHaveLength(1);
    expect(result.surfaced_fact_ids).toContain(KG_OUTCOME_FACT.fact_id);
  });

  it("inputSchema rejects non-UUID reaction_id", () => {
    const { pool } = mockPool();
    const tool = buildExpandReactionContextTool(pool, MCP_KG_URL);
    const r = tool.inputSchema.safeParse({ reaction_id: "not-a-uuid" });
    expect(r.success).toBe(false);
  });
});
