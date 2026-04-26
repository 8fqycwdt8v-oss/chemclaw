// Tests for buildFetchInstrumentRunTool.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildFetchInstrumentRunTool } from "../../../src/tools/builtins/fetch_instrument_run.js";

const LOGS_URL = "http://mcp-logs-sciy:8016";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

const FAKE_DATASET = {
  backend: "fake-postgres",
  uid: "LOGS-000001",
  name: "HPLC run",
  instrument_kind: "HPLC",
  instrument_serial: "WATERS-1234",
  method_name: "HPLC-A",
  sample_id: "S-NCE-1234-00001",
  sample_name: "lot-001",
  operator: "alice.adams01",
  measured_at: "2026-04-01T12:00:00+00:00",
  parameters: { flow_rate_ml_min: 1.0 },
  tracks: [],
  project_code: "NCE-1234",
  citation_uri: "local-mock-logs://logs/dataset/LOGS-000001",
};

const FAKE_RESPONSE = {
  dataset: FAKE_DATASET,
  valid_until: "2026-05-03T12:00:00+00:00",
};

afterEach(() => vi.unstubAllGlobals());

describe("buildFetchInstrumentRunTool", () => {
  it("posts the uid to /datasets/fetch and parses the response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildFetchInstrumentRunTool(LOGS_URL);
    const result = await tool.execute(makeCtx(), { uid: "LOGS-000001" });

    expect(result.dataset.uid).toBe("LOGS-000001");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${LOGS_URL}/datasets/fetch`);
    expect(JSON.parse(init.body as string)).toEqual({ uid: "LOGS-000001" });
  });

  it("rejects a uid containing a space", () => {
    const tool = buildFetchInstrumentRunTool(LOGS_URL);
    expect(tool.inputSchema.safeParse({ uid: "not legal id" }).success).toBe(false);
  });

  it("requires the uid field", () => {
    const tool = buildFetchInstrumentRunTool(LOGS_URL);
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("propagates 404 from the MCP", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "not_found",
      }),
    );
    const tool = buildFetchInstrumentRunTool(LOGS_URL);
    await expect(tool.execute(makeCtx(), { uid: "LOGS-MISS" })).rejects.toThrow(
      /404/,
    );
  });
});
