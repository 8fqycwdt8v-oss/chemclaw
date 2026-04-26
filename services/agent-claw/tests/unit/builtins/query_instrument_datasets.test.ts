// Tests for buildQueryInstrumentDatasetsTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildQueryInstrumentDatasetsTool } from "../../../src/tools/builtins/query_instrument_datasets.js";

const LOGS_URL = "http://mcp-logs-sciy:8016";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

const FAKE_DATASETS = [
  {
    backend: "fake-postgres",
    uid: "LOGS-000001",
    name: "HPLC run",
    instrument_kind: "HPLC",
    sample_id: "S-NCE-1234-00001",
    operator: "alice.adams01",
    measured_at: "2026-04-01T12:00:00+00:00",
    parameters: {},
    tracks: [],
    citation_uri: "local-mock-logs://logs/dataset/LOGS-000001",
  },
  {
    backend: "fake-postgres",
    uid: "LOGS-000002",
    name: "NMR run",
    instrument_kind: "NMR",
    sample_id: "S-NCE-1234-00001",
    operator: "alice.adams01",
    measured_at: "2026-04-02T12:00:00+00:00",
    parameters: {},
    tracks: [],
    citation_uri: "local-mock-logs://logs/dataset/LOGS-000002",
  },
];

const FAKE_RESPONSE = {
  datasets: FAKE_DATASETS,
  valid_until: "2026-05-03T12:00:00+00:00",
};

afterEach(() => vi.unstubAllGlobals());

describe("buildQueryInstrumentDatasetsTool", () => {
  it("posts the sample_id to /datasets/by_sample and parses the response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildQueryInstrumentDatasetsTool(LOGS_URL);
    const result = await tool.execute(makeCtx(), {
      sample_id: "S-NCE-1234-00001",
    });

    expect(result.datasets).toHaveLength(2);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${LOGS_URL}/datasets/by_sample`);
    expect(JSON.parse(init.body as string)).toEqual({
      sample_id: "S-NCE-1234-00001",
    });
  });

  it("rejects a sample_id containing illegal characters", () => {
    const tool = buildQueryInstrumentDatasetsTool(LOGS_URL);
    expect(
      tool.inputSchema.safeParse({ sample_id: "S NCE 1234 0001" }).success,
    ).toBe(false);
  });

  it("requires the sample_id field", () => {
    const tool = buildQueryInstrumentDatasetsTool(LOGS_URL);
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("propagates upstream errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "degraded",
      }),
    );
    const tool = buildQueryInstrumentDatasetsTool(LOGS_URL);
    await expect(
      tool.execute(makeCtx(), { sample_id: "S-NCE-1234-00001" }),
    ).rejects.toThrow(/503/);
  });
});
