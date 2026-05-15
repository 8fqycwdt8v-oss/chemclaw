// Tests for buildRequestInvestigationTool — Universal Knowledge
// Accumulation Phase 0 (Task 12). The builtin enqueues a high-priority
// (score=1.0, manual_request) row in investigation_queue so the (Phase
// 3+) interpreter will deep-dive a specific fact.

import { describe, it, expect } from "vitest";
import { buildRequestInvestigationTool } from "../../../src/tools/builtins/request_investigation.js";
import { mockPool } from "../../helpers/mock-pg.js";
import { makeCtx } from "../../helpers/make-ctx.js";

const FACT_UUID = "00000000-0000-0000-0000-000000000111";
const QUEUE_UUID = "00000000-0000-0000-0000-000000000456";

function pushHappyPath(client: ReturnType<typeof mockPool>["client"]): void {
  // withUserContext wraps the body in BEGIN / set_config / ... / COMMIT.
  // Tool body issues a single INSERT.
  client.queryResults.push(
    { rows: [], rowCount: 0 }, // BEGIN
    { rows: [], rowCount: 0 }, // set_config
    { rows: [{ id: QUEUE_UUID }], rowCount: 1 }, // INSERT INTO investigation_queue
    { rows: [], rowCount: 0 }, // COMMIT
  );
}

describe("buildRequestInvestigationTool — happy path", () => {
  it("enqueues an investigation_queue row with score=1.0 and returns queue_id", async () => {
    const { pool, client } = mockPool();
    pushHappyPath(client);

    const tool = buildRequestInvestigationTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    const result = await tool.execute(ctx, {
      fact_id: FACT_UUID,
      reason: "this looks anomalous, please dig deeper",
    });

    expect(result).toMatchObject({ ok: true, queue_id: QUEUE_UUID });

    const insertCall = client.querySpy.mock.calls.find((args) => {
      const first = args[0];
      const text =
        typeof first === "string" ? first : (first as { text: string }).text;
      return text.includes("INSERT INTO investigation_queue");
    });
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    // [fact_id, project_id, score, reason_codes]
    expect(params[0]).toBe(FACT_UUID);
    expect(params[2]).toBe(1.0);
  });

  it("includes 'manual_request' as the first reason_codes entry", async () => {
    const { pool, client } = mockPool();
    pushHappyPath(client);

    const tool = buildRequestInvestigationTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    await tool.execute(ctx, {
      fact_id: FACT_UUID,
      reason: "anomalous yield drop suggests SNAr selectivity loss",
    });

    const insertCall = client.querySpy.mock.calls.find((args) => {
      const first = args[0];
      const text =
        typeof first === "string" ? first : (first as { text: string }).text;
      return text.includes("INSERT INTO investigation_queue");
    });
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    const reasonCodes = params[3] as string[];
    expect(reasonCodes[0]).toBe("manual_request");
    // Reason text appears (truncated to 64 chars) as second entry.
    expect(reasonCodes[1].length).toBeLessThanOrEqual(64);
    expect(reasonCodes.some((s) => s.includes("anomalous"))).toBe(true);
  });

  it("truncates reason text longer than 64 chars in the stored reason_code", async () => {
    const { pool, client } = mockPool();
    pushHappyPath(client);

    const tool = buildRequestInvestigationTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    const longReason = "a".repeat(200);
    await tool.execute(ctx, {
      fact_id: FACT_UUID,
      reason: longReason,
    });

    const insertCall = client.querySpy.mock.calls.find((args) => {
      const first = args[0];
      const text =
        typeof first === "string" ? first : (first as { text: string }).text;
      return text.includes("INSERT INTO investigation_queue");
    });
    const params = insertCall![1] as unknown[];
    const reasonCodes = params[3] as string[];
    expect(reasonCodes[1].length).toBe(64);
  });

  it("passes ctx.nceProjectId through as project_id", async () => {
    const { pool, client } = mockPool();
    pushHappyPath(client);

    const tool = buildRequestInvestigationTool(pool);
    const projectUuid = "00000000-0000-0000-0000-0000000000aa";
    const ctx = makeCtx("scientist@pharma.com", [], {
      nceProjectId: projectUuid,
    });

    await tool.execute(ctx, {
      fact_id: FACT_UUID,
      reason: "deep dive please",
    });

    const insertCall = client.querySpy.mock.calls.find((args) => {
      const first = args[0];
      const text =
        typeof first === "string" ? first : (first as { text: string }).text;
      return text.includes("INSERT INTO investigation_queue");
    });
    const params = insertCall![1] as unknown[];
    expect(params[1]).toBe(projectUuid);
  });
});

describe("buildRequestInvestigationTool — schema validation", () => {
  it("inputSchema rejects reason shorter than 3 chars", () => {
    const { pool } = mockPool();
    const tool = buildRequestInvestigationTool(pool);
    const r = tool.inputSchema.safeParse({
      fact_id: FACT_UUID,
      reason: "x",
    });
    expect(r.success).toBe(false);
  });

  it("inputSchema rejects reason longer than 500 chars", () => {
    const { pool } = mockPool();
    const tool = buildRequestInvestigationTool(pool);
    const r = tool.inputSchema.safeParse({
      fact_id: FACT_UUID,
      reason: "a".repeat(501),
    });
    expect(r.success).toBe(false);
  });

  it("inputSchema rejects malformed fact_id (not a UUID)", () => {
    const { pool } = mockPool();
    const tool = buildRequestInvestigationTool(pool);
    const r = tool.inputSchema.safeParse({
      fact_id: "not-a-uuid",
      reason: "deep dive please",
    });
    expect(r.success).toBe(false);
  });

});

describe("buildRequestInvestigationTool — failure surface", () => {
  it("throws if INSERT INTO investigation_queue returns no row", async () => {
    // No canned results pushed — every client.query returns {rows: [], rowCount: 0}.
    const { pool } = mockPool();
    const tool = buildRequestInvestigationTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    await expect(
      tool.execute(ctx, {
        fact_id: FACT_UUID,
        reason: "deep dive please",
      }),
    ).rejects.toThrow(/did not RETURN a row/);
  });
});
