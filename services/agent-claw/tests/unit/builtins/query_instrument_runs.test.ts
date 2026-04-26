// Tests for buildQueryInstrumentRunsTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildQueryInstrumentRunsTool } from "../../../src/tools/builtins/query_instrument_runs.js";

const LOGS_URL = "http://mcp-logs-sciy:8016";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

const FAKE_DATASET = {
  backend: "fake-postgres",
  uid: "LOGS-000001",
  name: "HPLC HPLC-A run 1",
  instrument_kind: "HPLC",
  instrument_serial: "WATERS-1234",
  method_name: "HPLC-A",
  sample_id: "S-NCE-1234-00001",
  sample_name: "lot-001",
  operator: "alice.adams01",
  measured_at: "2026-04-01T12:00:00+00:00",
  parameters: { flow_rate_ml_min: 1.0 },
  tracks: [
    { track_index: 0, detector: "UV", unit: "mAU", peaks: [{ rt_min: 1.23, area: 100 }] },
  ],
  project_code: "NCE-1234",
  citation_uri: "local-mock-logs://logs/dataset/LOGS-000001",
};

const FAKE_RESPONSE = {
  datasets: [FAKE_DATASET],
  next_cursor: null,
  valid_until: "2026-05-03T12:00:00+00:00",
};

afterEach(() => vi.unstubAllGlobals());

describe("buildQueryInstrumentRunsTool", () => {
  it("posts filters to /datasets/query and parses the response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildQueryInstrumentRunsTool(LOGS_URL);
    const result = await tool.execute(makeCtx(), {
      instrument_kind: ["HPLC", "MS"],
      project_code: "NCE-1234",
      limit: 25,
    });

    expect(result.datasets).toHaveLength(1);
    expect(result.datasets[0].uid).toBe("LOGS-000001");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${LOGS_URL}/datasets/query`);
    const body = JSON.parse(init.body as string);
    expect(body.instrument_kind).toEqual(["HPLC", "MS"]);
    expect(body.project_code).toBe("NCE-1234");
    expect(body.limit).toBe(25);
  });

  it("rejects an invalid project_code", () => {
    const tool = buildQueryInstrumentRunsTool(LOGS_URL);
    expect(
      tool.inputSchema.safeParse({ project_code: "robert; DROP TABLE" }).success,
    ).toBe(false);
  });

  it("rejects an unknown instrument_kind", () => {
    const tool = buildQueryInstrumentRunsTool(LOGS_URL);
    expect(
      tool.inputSchema.safeParse({ instrument_kind: ["RAMAN"] }).success,
    ).toBe(false);
  });

  it("clamps limit to the documented range", () => {
    const tool = buildQueryInstrumentRunsTool(LOGS_URL);
    expect(tool.inputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ limit: 999 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ limit: 50 }).success).toBe(true);
  });

  it("propagates upstream errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "boom",
      }),
    );
    const tool = buildQueryInstrumentRunsTool(LOGS_URL);
    await expect(tool.execute(makeCtx(), {})).rejects.toThrow(/500/);
  });
});
