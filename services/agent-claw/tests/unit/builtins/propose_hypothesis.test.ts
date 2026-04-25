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
