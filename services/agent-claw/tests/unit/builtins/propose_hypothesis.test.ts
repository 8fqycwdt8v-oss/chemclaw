// Tests for buildProposeHypothesisTool — including anti-fabrication hard guard.

import { describe, it, expect } from "vitest";
import { buildProposeHypothesisTool } from "../../../src/tools/builtins/propose_hypothesis.js";
import { mockPool } from "../../helpers/mock-pg.js";
import { makeCtx } from "../../helpers/make-ctx.js";

const FACT_UUID_1 = "aaaaaaaa-1111-2222-3333-444444444444";
const FACT_UUID_2 = "aaaaaaaa-1111-2222-3333-555555555555";
const HYPO_UUID = "cccccccc-1111-2222-3333-444444444444";

function makeDbResults(hypothesisId: string) {
  return [
    { rows: [], rowCount: 0 }, // BEGIN
    { rows: [], rowCount: 0 }, // set_config
    { rows: [{ id: hypothesisId, confidence_tier: "medium", created_at: "2025-01-01T00:00:00Z" }], rowCount: 1 }, // INSERT hypotheses
    { rows: [], rowCount: 0 }, // INSERT hypothesis_citations (fact 1)
    { rows: [], rowCount: 0 }, // INSERT ingestion_events
    { rows: [], rowCount: 0 }, // COMMIT
  ];
}

describe("buildProposeHypothesisTool — anti-fabrication guard", () => {
  it("succeeds when all cited fact_ids are in seenFactIds", async () => {
    const { pool, client } = mockPool();
    client.queryResults.push(...makeDbResults(HYPO_UUID));

    const tool = buildProposeHypothesisTool(pool);
    const ctx = makeCtx("scientist@pharma.com", [FACT_UUID_1]);

    const result = await tool.execute(ctx, {
      hypothesis_text: "Catalyst A gives higher yield when temp is below 100°C.",
      cited_fact_ids: [FACT_UUID_1],
      confidence: 0.75,
    });

    expect(result.hypothesis_id).toBe(HYPO_UUID);
    expect(result.confidence_tier).toBe("medium");
    expect(result.projection_status).toBe("pending");
  });

  it("HARD REJECTS when a cited fact_id is NOT in seenFactIds", async () => {
    const { pool } = mockPool();
    const tool = buildProposeHypothesisTool(pool);
    // seenFactIds only has FACT_UUID_1; hypothesis cites FACT_UUID_2
    const ctx = makeCtx("scientist@pharma.com", [FACT_UUID_1]);

    await expect(
      tool.execute(ctx, {
        hypothesis_text: "Yield correlates with time and temperature in this reaction.",
        cited_fact_ids: [FACT_UUID_1, FACT_UUID_2], // FACT_UUID_2 is unseen
        confidence: 0.6,
      }),
    ).rejects.toThrow(/cited_fact_ids not seen in this turn/);
  });

  it("HARD REJECTS when seenFactIds is completely empty", async () => {
    const { pool } = mockPool();
    const tool = buildProposeHypothesisTool(pool);
    const ctx = makeCtx("scientist@pharma.com"); // empty seenFactIds

    await expect(
      tool.execute(ctx, {
        hypothesis_text: "Catalyst loading matters more than temperature.",
        cited_fact_ids: [FACT_UUID_1],
        confidence: 0.5,
      }),
    ).rejects.toThrow(/cited_fact_ids not seen in this turn/);
  });

  it("inputSchema rejects cited_fact_ids with 0 items", () => {
    const { pool } = mockPool();
    const tool = buildProposeHypothesisTool(pool);
    const r = tool.inputSchema.safeParse({
      hypothesis_text: "A hypothesis that cites nothing.",
      cited_fact_ids: [],
      confidence: 0.5,
    });
    expect(r.success).toBe(false);
  });

  it("inputSchema rejects confidence outside [0,1]", () => {
    const { pool } = mockPool();
    const tool = buildProposeHypothesisTool(pool);
    const r = tool.inputSchema.safeParse({
      hypothesis_text: "Some hypothesis text here.",
      cited_fact_ids: [FACT_UUID_1],
      confidence: 1.5,
    });
    expect(r.success).toBe(false);
  });

  it("succeeds with two seeded facts and cites both", async () => {
    const { pool, client } = mockPool();
    // Citation loop for FACT_UUID_1 and FACT_UUID_2
    client.queryResults.push(
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [], rowCount: 0 }, // set_config
      { rows: [{ id: HYPO_UUID, confidence_tier: "high", created_at: "2025-01-01T00:00:00Z" }], rowCount: 1 },
      { rows: [], rowCount: 0 }, // INSERT citation 1
      { rows: [], rowCount: 0 }, // INSERT citation 2
      { rows: [], rowCount: 0 }, // INSERT ingestion_events
      { rows: [], rowCount: 0 }, // COMMIT
    );

    const tool = buildProposeHypothesisTool(pool);
    const ctx = makeCtx("scientist@pharma.com", [FACT_UUID_1, FACT_UUID_2]);

    const result = await tool.execute(ctx, {
      hypothesis_text: "Both facts support the hypothesis that yield is temperature-dependent.",
      cited_fact_ids: [FACT_UUID_1, FACT_UUID_2],
      confidence: 0.85,
    });

    expect(result.hypothesis_id).toBe(HYPO_UUID);
  });
});

// ---------------------------------------------------------------------------
// Idempotency: duplicate cited_fact_ids must not abort the transaction
// ---------------------------------------------------------------------------
//
// hypothesis_citations has PRIMARY KEY (hypothesis_id, fact_id). Pre-fix,
// passing [fact1, fact2, fact1] would raise a PK-violation on the second
// fact1 INSERT and roll back the whole transaction — losing the
// hypothesis row that already INSERTed. ON CONFLICT DO NOTHING resolves
// the conflict server-side; first citation_note wins.

describe("buildProposeHypothesisTool — citation INSERT idempotency", () => {
  it("uses ON CONFLICT DO NOTHING on the citation INSERT (review §3.8)", async () => {
    const { pool, client } = mockPool();
    client.queryResults.push(...makeDbResults(HYPO_UUID));

    const tool = buildProposeHypothesisTool(pool);
    const ctx = makeCtx("scientist@pharma.com", [FACT_UUID_1]);

    await tool.execute(ctx, {
      hypothesis_text: "Catalyst A gives higher yield when temp is below 100°C.",
      cited_fact_ids: [FACT_UUID_1],
      confidence: 0.75,
    });

    // Capture the citation INSERT (querySpy.mock.calls[i][0] is the SQL
    // text or { text } config object passed to client.query).
    const citationInsert = client.querySpy.mock.calls
      .map((args) => {
        const first = args[0];
        return typeof first === "string" ? first : (first as { text: string }).text;
      })
      .find(
        (text) =>
          text.includes("INSERT INTO hypothesis_citations") &&
          text.includes("ON CONFLICT"),
      );
    expect(
      citationInsert,
      "expected hypothesis_citations INSERT to use ON CONFLICT DO NOTHING",
    ).toBeDefined();
    expect(citationInsert).toContain("(hypothesis_id, fact_id) DO NOTHING");
  });

  it("survives duplicate fact_ids in cited_fact_ids without aborting", async () => {
    const { pool, client } = mockPool();
    // Three INSERT citation calls (one per loop iteration); the 2nd and 3rd
    // both target FACT_UUID_1 so the second would normally PK-violate. With
    // ON CONFLICT DO NOTHING the SQL is still issued but returns rowCount=0.
    client.queryResults.push(
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [], rowCount: 0 }, // set_config
      { rows: [{ id: HYPO_UUID, confidence_tier: "medium", created_at: "2025-01-01T00:00:00Z" }], rowCount: 1 },
      { rows: [], rowCount: 0 }, // INSERT citation 1 (fact_1)
      { rows: [], rowCount: 0 }, // INSERT citation 2 (fact_2)
      { rows: [], rowCount: 0 }, // INSERT citation 3 (fact_1 dup — DO NOTHING)
      { rows: [], rowCount: 0 }, // INSERT ingestion_events
      { rows: [], rowCount: 0 }, // COMMIT
    );

    const tool = buildProposeHypothesisTool(pool);
    const ctx = makeCtx("scientist@pharma.com", [FACT_UUID_1, FACT_UUID_2]);

    const result = await tool.execute(ctx, {
      hypothesis_text: "The agent batched its retrieval and accidentally cited fact_1 twice.",
      cited_fact_ids: [FACT_UUID_1, FACT_UUID_2, FACT_UUID_1],
      confidence: 0.6,
    });

    expect(result.hypothesis_id).toBe(HYPO_UUID);
  });
});
