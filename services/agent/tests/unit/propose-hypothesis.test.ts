import { describe, it, expect, vi } from "vitest";
import {
  ProposeHypothesisInput,
  proposeHypothesis,
} from "../../src/tools/propose-hypothesis.js";

const HID = "55555555-5555-5555-5555-555555555555";
const FACT_OK = "ffffffff-0000-4000-8000-000000000001";
const FACT_UNSEEN = "ffffffff-0000-4000-8000-000000000002";

function mockPool(capture: any) {
  const client = {
    query: vi.fn(async (sql: string, params: any[]) => {
      if (/INSERT INTO hypotheses/i.test(sql)) {
        capture.hypothesis_params = params;
        return { rows: [{ id: HID, confidence_tier: "high", created_at: new Date().toISOString() }] };
      }
      if (/INSERT INTO hypothesis_citations/i.test(sql)) {
        capture.citation_rows = (capture.citation_rows ?? 0) + 1;
        return { rows: [] };
      }
      if (/INSERT INTO ingestion_events/i.test(sql)) {
        capture.emitted_event = params;
        return { rows: [] };
      }
      return { rows: [] };
    }),
    release: () => void 0,
  };
  return { connect: vi.fn(async () => client) } as any;
}

describe("propose_hypothesis", () => {
  it("rejects citations that the agent has not seen", async () => {
    const capture: any = {};
    const pool = mockPool(capture);
    await expect(
      proposeHypothesis(
        ProposeHypothesisInput.parse({
          hypothesis_text: "Cross-project Suzuki yields correlate with base class.",
          cited_fact_ids: [FACT_UNSEEN],
          confidence: 0.7,
        }),
        {
          pool, userEntraId: "user-a",
          seenFactIds: new Set([FACT_OK]),
        },
      ),
    ).rejects.toThrow(/not.*seen|unknown.*fact/i);
    expect(capture.hypothesis_params).toBeUndefined();
  });

  it("persists + emits event on happy path", async () => {
    const capture: any = {};
    const pool = mockPool(capture);
    const out = await proposeHypothesis(
      ProposeHypothesisInput.parse({
        hypothesis_text: "Cross-project Suzuki yields correlate with base class.",
        cited_fact_ids: [FACT_OK],
        confidence: 0.9,
      }),
      {
        pool, userEntraId: "user-a",
        seenFactIds: new Set([FACT_OK]),
      },
    );
    expect(out.hypothesis_id).toBe(HID);
    expect(out.projection_status).toBe("pending");
    expect(capture.citation_rows).toBe(1);
    expect(capture.emitted_event[0]).toBe("hypothesis_proposed");
  });
});
