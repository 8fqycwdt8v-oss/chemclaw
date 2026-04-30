// Tests for buildFindSimilarReactionsTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildFindSimilarReactionsTool } from "../../../src/tools/builtins/find_similar_reactions.js";
import { mockPool } from "../../helpers/mock-pg.js";
import { makeCtx } from "../../helpers/make-ctx.js";

const MCP_DRFP_URL = "http://mcp-drfp:8002";

const DRFP_RESPONSE = {
  vector: new Array(2048).fill(0).map((_, i) => (i % 7 === 0 ? 1 : 0)),
  on_bit_count: 292,
};

const DB_REACTION_ROW = {
  reaction_id: "aaaaaaaa-1111-2222-3333-444444444444",
  rxn_smiles: "CC>>CCC",
  rxno_class: "C-C coupling",
  distance: 0.12,
  experiment_id: "bbbbbbbb-1111-2222-3333-444444444444",
  eln_entry_id: "ELN-001",
  project_internal_id: "NCE-0042",
  yield_pct: 85.2,
  outcome_status: "success",
};

function mockFetchDrfp(drfpBody: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify(drfpBody),
  });
}

describe("buildFindSimilarReactionsTool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to mcp-drfp then queries pgvector and returns results", async () => {
    vi.stubGlobal("fetch", mockFetchDrfp(DRFP_RESPONSE));

    const { pool, client } = mockPool();
    // withUserContext: BEGIN, set_config, query result, COMMIT
    client.queryResults.push(
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [], rowCount: 0 }, // set_config
      { rows: [DB_REACTION_ROW], rowCount: 1 }, // SELECT reactions
      { rows: [], rowCount: 0 }, // COMMIT
    );

    const tool = buildFindSimilarReactionsTool(pool, MCP_DRFP_URL);
    const result = await tool.execute(makeCtx(), {
      rxn_smiles: "CC>>CCC",
      k: 5,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.reaction_id).toBe(DB_REACTION_ROW.reaction_id);
    expect(result.results[0]?.citation.source_kind).toBe("reaction");
    expect(result.seed_canonicalized.on_bit_count).toBe(DRFP_RESPONSE.on_bit_count);
  });

  it("throws when DRFP returns unexpected dimension", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ vector: [0, 1, 0], on_bit_count: 1 }),
      }),
    );

    const { pool } = mockPool();
    const tool = buildFindSimilarReactionsTool(pool, MCP_DRFP_URL);

    await expect(
      tool.execute(makeCtx(), { rxn_smiles: "CC>>CCC", k: 5 }),
    ).rejects.toThrow(/unexpected dim/);
  });

  it("returns empty results when pgvector finds nothing (RLS block)", async () => {
    vi.stubGlobal("fetch", mockFetchDrfp(DRFP_RESPONSE));

    const { pool, client } = mockPool();
    client.queryResults.push(
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [], rowCount: 0 }, // set_config
      { rows: [], rowCount: 0 }, // SELECT (RLS blocked — no rows)
      { rows: [], rowCount: 0 }, // COMMIT
    );

    const tool = buildFindSimilarReactionsTool(pool, MCP_DRFP_URL);
    const result = await tool.execute(makeCtx(), { rxn_smiles: "CC>>CCC", k: 10 });

    expect(result.results).toHaveLength(0);
  });

  it("inputSchema rejects rxn_smiles under 3 chars", () => {
    const { pool } = mockPool();
    const tool = buildFindSimilarReactionsTool(pool, MCP_DRFP_URL);
    const r = tool.inputSchema.safeParse({ rxn_smiles: "CC", k: 5 });
    expect(r.success).toBe(false);
  });

  it("inputSchema rejects k over 50", () => {
    const { pool } = mockPool();
    const tool = buildFindSimilarReactionsTool(pool, MCP_DRFP_URL);
    const r = tool.inputSchema.safeParse({ rxn_smiles: "CC>>CCC", k: 51 });
    expect(r.success).toBe(false);
  });
});
