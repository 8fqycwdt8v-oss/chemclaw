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

describe("buildFindSimilarReactionsTool — Z2 structured filters", () => {
  afterEach(() => vi.unstubAllGlobals());

  function _findSelectSql(client: { querySpy: { mock: { calls: unknown[][] } } }): string {
    const calls = client.querySpy.mock.calls as Array<[string | { text: string }, ...unknown[]]>;
    const found = calls.find(([q]) =>
      (typeof q === "string" ? q : q.text).includes("drfp_vector <=>"),
    );
    if (!found) return "";
    const q = found[0];
    return typeof q === "string" ? q : q.text;
  }

  function _findSelectParams(client: { querySpy: { mock: { calls: unknown[][] } } }): unknown[] {
    const calls = client.querySpy.mock.calls as Array<[string | { text: string }, unknown[]]>;
    const found = calls.find(([q]) =>
      (typeof q === "string" ? q : q.text).includes("drfp_vector <=>"),
    );
    if (!found) return [];
    return found[1];
  }

  it("forwards solvent param to SQL", async () => {
    vi.stubGlobal("fetch", mockFetchDrfp(DRFP_RESPONSE));
    const { pool, client } = mockPool();
    client.queryResults.push(
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    );

    const tool = buildFindSimilarReactionsTool(pool, MCP_DRFP_URL);
    await tool.execute(makeCtx(), {
      rxn_smiles: "CC>>CCC",
      k: 5,
      solvent: "EtOH",
    });

    expect(_findSelectSql(client)).toMatch(/r\.solvent = \$5/);
    expect(_findSelectParams(client)).toContain("EtOH");
  });

  it("forwards temperature range params to SQL", async () => {
    vi.stubGlobal("fetch", mockFetchDrfp(DRFP_RESPONSE));
    const { pool, client } = mockPool();
    client.queryResults.push(
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    );
    const tool = buildFindSimilarReactionsTool(pool, MCP_DRFP_URL);
    await tool.execute(makeCtx(), {
      rxn_smiles: "CC>>CCC",
      k: 5,
      min_temperature_c: 50,
      max_temperature_c: 120,
    });
    const sql = _findSelectSql(client);
    expect(sql).toMatch(/r\.temperature_c >= \$7/);
    expect(sql).toMatch(/r\.temperature_c <= \$8/);
    const params = _findSelectParams(client);
    expect(params).toContain(50);
    expect(params).toContain(120);
  });

  it("does not break existing callers (omitted Z2 params bind to null)", async () => {
    vi.stubGlobal("fetch", mockFetchDrfp(DRFP_RESPONSE));
    const { pool, client } = mockPool();
    client.queryResults.push(
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    );
    const tool = buildFindSimilarReactionsTool(pool, MCP_DRFP_URL);
    await tool.execute(makeCtx(), { rxn_smiles: "CC>>CCC", k: 5 });
    const params = _findSelectParams(client);
    expect(params).toBeDefined();
    // Solvent / base / min_temp / max_temp params (positions 4..7 zero-indexed)
    // should all be null.
    expect(params.slice(4)).toEqual([null, null, null, null]);
  });
});
