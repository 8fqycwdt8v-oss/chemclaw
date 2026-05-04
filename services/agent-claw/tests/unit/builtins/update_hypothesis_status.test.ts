// Tests for buildUpdateHypothesisStatusTool — Tranche 1 / C3 emitter.
//
// The tool's contract:
//   * UPDATEs hypotheses.status (and refuted_at when transitioning to refuted).
//   * Does NOT explicitly INSERT into ingestion_events — the
//     trg_hypotheses_status_event trigger added in
//     db/init/35_event_type_vocabulary.sql does that. So the unit test only
//     needs to assert the UPDATE shape; the trigger side is exercised by the
//     Postgres integration suite.
//   * Throws on no-op transitions (RLS denied, hypothesis missing, or
//     status already equals new_status).

import { describe, it, expect } from "vitest";
import { buildUpdateHypothesisStatusTool } from "../../../src/tools/builtins/update_hypothesis_status.js";
import { mockPool } from "../../helpers/mock-pg.js";
import { makeCtx } from "../../helpers/make-ctx.js";

const HID = "cccccccc-1111-2222-3333-444444444444";

function rlsTransactionFraming() {
  return [
    { rows: [], rowCount: 0 }, // BEGIN
    { rows: [], rowCount: 0 }, // SELECT set_config(...)
  ];
}

describe("buildUpdateHypothesisStatusTool", () => {
  it("returns the transition for a refuted-status update", async () => {
    const { pool, client } = mockPool();
    client.queryResults.push(
      ...rlsTransactionFraming(),
      // UPDATE … RETURNING …
      {
        rows: [
          {
            id: HID,
            old_status: "proposed",
            new_status: "refuted",
            refuted_at: new Date("2026-05-04T10:00:00Z"),
          },
        ],
        rowCount: 1,
      },
      { rows: [], rowCount: 0 }, // COMMIT
    );

    const tool = buildUpdateHypothesisStatusTool(pool);
    const result = await tool.execute(makeCtx(), {
      hypothesis_id: HID,
      new_status: "refuted",
    });

    expect(result.hypothesis_id).toBe(HID);
    expect(result.old_status).toBe("proposed");
    expect(result.new_status).toBe("refuted");
    expect(result.refuted_at).toBe("2026-05-04T10:00:00.000Z");
    expect(result.projection_status).toBe("pending");
  });

  it("uses the OLD.status IS DISTINCT guard so no-op UPDATEs return zero rows", async () => {
    const { pool, client } = mockPool();
    client.queryResults.push(
      ...rlsTransactionFraming(),
      // UPDATE returns zero rows when prev.status === new_status
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 }, // ROLLBACK on throw
    );

    const tool = buildUpdateHypothesisStatusTool(pool);

    await expect(
      tool.execute(makeCtx(), {
        hypothesis_id: HID,
        new_status: "refuted",
      }),
    ).rejects.toThrow(/no transition applied/);
  });

  it("does NOT emit ingestion_events from application code (DB trigger does)", async () => {
    // Asserts the UPDATE statement is the only meaningful SQL the tool runs
    // against `hypotheses` — guarding against a future regression where
    // someone adds a duplicate INSERT INTO ingestion_events here.
    const { pool, client } = mockPool();
    client.queryResults.push(
      ...rlsTransactionFraming(),
      {
        rows: [
          { id: HID, old_status: "proposed", new_status: "archived", refuted_at: null },
        ],
        rowCount: 1,
      },
      { rows: [], rowCount: 0 }, // COMMIT
    );

    const tool = buildUpdateHypothesisStatusTool(pool);
    await tool.execute(makeCtx(), {
      hypothesis_id: HID,
      new_status: "archived",
    });

    const statements = client.querySpy.mock.calls.map((call) => {
      const arg = call[0];
      return typeof arg === "string" ? arg : (arg as { text: string }).text;
    });
    const ingestionInserts = statements.filter((s) =>
      /INSERT INTO ingestion_events/i.test(s),
    );
    expect(ingestionInserts).toHaveLength(0);

    const updates = statements.filter((s) => /UPDATE hypotheses/i.test(s));
    expect(updates).toHaveLength(1);
  });

  it("inputSchema rejects an unknown status value", () => {
    const { pool } = mockPool();
    const tool = buildUpdateHypothesisStatusTool(pool);
    const r = tool.inputSchema.safeParse({
      hypothesis_id: HID,
      new_status: "deprecated", // not in the four-value enum
    });
    expect(r.success).toBe(false);
  });

  it("inputSchema rejects a non-uuid hypothesis_id", () => {
    const { pool } = mockPool();
    const tool = buildUpdateHypothesisStatusTool(pool);
    const r = tool.inputSchema.safeParse({
      hypothesis_id: "not-a-uuid",
      new_status: "refuted",
    });
    expect(r.success).toBe(false);
  });
});
