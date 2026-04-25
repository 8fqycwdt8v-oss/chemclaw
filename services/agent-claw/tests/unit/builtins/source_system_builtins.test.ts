// Tests for all 6 source-system builtins (Phase F.2).
// MCP endpoints are mocked via global fetch.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool } from "pg";
import type { ToolContext } from "../../../src/core/types.js";
import { buildQueryElnExperimentsTool } from "../../../src/tools/builtins/query_eln_experiments.js";
import { buildFetchElnEntryTool } from "../../../src/tools/builtins/fetch_eln_entry.js";
import { buildQueryLimsResultsTool } from "../../../src/tools/builtins/query_lims_results.js";
import { buildFetchLimsResultTool } from "../../../src/tools/builtins/fetch_lims_result.js";
import { buildQueryInstrumentRunsTool } from "../../../src/tools/builtins/query_instrument_runs.js";
import { buildFetchInstrumentRunTool } from "../../../src/tools/builtins/fetch_instrument_run.js";

// ---------- Mock infrastructure ----------------------------------------------

// postJson is used by query_* tools; fetch is used by fetch_* tools.
vi.mock("../../../src/mcp/postJson.js", () => ({
  postJson: vi.fn(),
}));

const mockPool = {} as Pool;

const mockCtx: ToolContext = {
  userEntraId: "chemist@pharma.com",
  scratchpad: new Map(),
  seenFactIds: new Set(),
};

function fakeEntry(id = "etr_001") {
  return {
    id,
    schema_id: "sch_x",
    fields: { yield_pct: { value: 87.5 } },
    attached_files: [{ document_id: "doc_1", original_uri: "https://benchling.com/files/1" }],
    created_at: "2024-01-15T10:00:00Z",
    modified_at: "2024-01-16T08:30:00Z",
  };
}

function fakeResult(id = "res_001") {
  return {
    id,
    sample_id: "smp_A",
    method_id: "meth_hplc",
    analysis_name: "HPLC Purity",
    result_value: "98.7",
    result_unit: "%",
    status: "Complete",
    analyst: "j.smith@pharma.com",
    completed_at: "2024-03-10T14:22:00Z",
  };
}

function fakeRun(id = "run_W001") {
  return {
    id,
    sample_name: "NCE-001-A",
    method_name: "HPLC-C18",
    instrument_name: "Acquity01",
    run_date: "2024-04-01T09:00:00Z",
    peaks: [
      { peak_name: "Main", retention_time_min: 3.42, area: 985000, area_pct: 98.5 },
    ],
    total_area: 985000,
  };
}

// ---------- query_eln_experiments --------------------------------------------

describe("query_eln_experiments", () => {
  it("returns entries with citations", async () => {
    const { postJson } = await import("../../../src/mcp/postJson.js");
    vi.mocked(postJson).mockResolvedValue({
      entries: [fakeEntry()],
      next_page_token: null,
    });

    const tool = buildQueryElnExperimentsTool(mockPool, "http://localhost:8013");
    const result = await tool.execute(mockCtx, { limit: 10 });

    expect(result.source_system).toBe("benchling");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.id).toBe("etr_001");
    expect(result.entries[0]!.citation).toBeDefined();
    expect((result.entries[0]!.citation as { source_kind: string }).source_kind).toBe("external_url");
  });

  it("passes project_id filter to MCP", async () => {
    const { postJson } = await import("../../../src/mcp/postJson.js");
    vi.mocked(postJson).mockResolvedValue({ entries: [] });

    const tool = buildQueryElnExperimentsTool(mockPool, "http://localhost:8013");
    await tool.execute(mockCtx, { project_id: "proj_001", limit: 5 });

    expect(vi.mocked(postJson)).toHaveBeenCalledWith(
      expect.stringContaining("/query_runs"),
      expect.objectContaining({ project_id: "proj_001", limit: 5 }),
      expect.anything(),
      expect.any(Number),
      expect.any(String),
    );
  });

  it("handles empty entries list", async () => {
    const { postJson } = await import("../../../src/mcp/postJson.js");
    vi.mocked(postJson).mockResolvedValue({ entries: [] });

    const tool = buildQueryElnExperimentsTool(mockPool, "http://localhost:8013");
    const result = await tool.execute(mockCtx, { limit: 10 });

    expect(result.entries).toHaveLength(0);
  });
});

// ---------- fetch_eln_entry --------------------------------------------------

describe("fetch_eln_entry", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("returns entry with citation on success", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => fakeEntry("etr_abc"),
    } as unknown as Response);

    const tool = buildFetchElnEntryTool(mockPool, "http://localhost:8013");
    const result = await tool.execute(mockCtx, { entry_id: "etr_abc" });

    expect(result.id).toBe("etr_abc");
    expect(result.source_system).toBe("benchling");
    expect(result.citation).toBeDefined();
  });

  it("throws on non-OK response", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "not found",
      statusText: "Not Found",
    } as unknown as Response);

    const tool = buildFetchElnEntryTool(mockPool, "http://localhost:8013");
    await expect(tool.execute(mockCtx, { entry_id: "etr_missing" })).rejects.toThrow("404");
  });

  it("builds benchling URI in citation", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => fakeEntry("etr_xyz"),
    } as unknown as Response);

    const tool = buildFetchElnEntryTool(mockPool, "http://localhost:8013", "https://myco.benchling.com");
    const result = await tool.execute(mockCtx, { entry_id: "etr_xyz" });

    expect((result.citation as { source_uri: string }).source_uri).toContain("myco.benchling.com");
  });
});

// ---------- query_lims_results -----------------------------------------------

describe("query_lims_results", () => {
  it("returns results with citations", async () => {
    const { postJson } = await import("../../../src/mcp/postJson.js");
    vi.mocked(postJson).mockResolvedValue({
      results: [fakeResult()],
      total_count: 1,
    });

    const tool = buildQueryLimsResultsTool(mockPool, "http://localhost:8014");
    const result = await tool.execute(mockCtx, { limit: 20 });

    expect(result.source_system).toBe("starlims");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.id).toBe("res_001");
    expect((result.results[0]!.citation as { source_kind: string }).source_kind).toBe("external_url");
  });

  it("passes sample_id filter to MCP", async () => {
    const { postJson } = await import("../../../src/mcp/postJson.js");
    vi.mocked(postJson).mockResolvedValue({ results: [], total_count: 0 });

    const tool = buildQueryLimsResultsTool(mockPool, "http://localhost:8014");
    await tool.execute(mockCtx, { sample_id: "smp_X", limit: 10 });

    expect(vi.mocked(postJson)).toHaveBeenCalledWith(
      expect.stringContaining("/query_results"),
      expect.objectContaining({ sample_id: "smp_X" }),
      expect.anything(),
      expect.any(Number),
      expect.any(String),
    );
  });

  it("handles empty results", async () => {
    const { postJson } = await import("../../../src/mcp/postJson.js");
    vi.mocked(postJson).mockResolvedValue({ results: [] });

    const tool = buildQueryLimsResultsTool(mockPool, "http://localhost:8014");
    const result = await tool.execute(mockCtx, { limit: 10 });
    expect(result.results).toHaveLength(0);
  });
});

// ---------- fetch_lims_result ------------------------------------------------

describe("fetch_lims_result", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("returns result with citation on success", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => fakeResult("res_999"),
    } as unknown as Response);

    const tool = buildFetchLimsResultTool(mockPool, "http://localhost:8014");
    const result = await tool.execute(mockCtx, { result_id: "res_999" });

    expect(result.id).toBe("res_999");
    expect(result.source_system).toBe("starlims");
    expect(result.citation).toBeDefined();
  });

  it("throws on 404", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "not found",
      statusText: "Not Found",
    } as unknown as Response);

    const tool = buildFetchLimsResultTool(mockPool, "http://localhost:8014");
    await expect(tool.execute(mockCtx, { result_id: "res_missing" })).rejects.toThrow();
  });
});

// ---------- query_instrument_runs --------------------------------------------

describe("query_instrument_runs", () => {
  it("returns runs with citations", async () => {
    const { postJson } = await import("../../../src/mcp/postJson.js");
    vi.mocked(postJson).mockResolvedValue({
      runs: [fakeRun()],
      total_count: 1,
    });

    const tool = buildQueryInstrumentRunsTool(mockPool, "http://localhost:8015");
    const result = await tool.execute(mockCtx, { limit: 10 });

    expect(result.source_system).toBe("waters");
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]!.id).toBe("run_W001");
    expect((result.runs[0]!.citation as { source_kind: string }).source_kind).toBe("external_url");
  });

  it("passes date_from filter to MCP", async () => {
    const { postJson } = await import("../../../src/mcp/postJson.js");
    vi.mocked(postJson).mockResolvedValue({ runs: [] });

    const tool = buildQueryInstrumentRunsTool(mockPool, "http://localhost:8015");
    await tool.execute(mockCtx, { date_from: "2024-01-01", limit: 5 });

    expect(vi.mocked(postJson)).toHaveBeenCalledWith(
      expect.stringContaining("/search_runs"),
      expect.objectContaining({ date_from: "2024-01-01" }),
      expect.anything(),
      expect.any(Number),
      expect.any(String),
    );
  });

  it("handles empty runs list", async () => {
    const { postJson } = await import("../../../src/mcp/postJson.js");
    vi.mocked(postJson).mockResolvedValue({ runs: [] });

    const tool = buildQueryInstrumentRunsTool(mockPool, "http://localhost:8015");
    const result = await tool.execute(mockCtx, { limit: 10 });
    expect(result.runs).toHaveLength(0);
  });
});

// ---------- fetch_instrument_run ---------------------------------------------

describe("fetch_instrument_run", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("returns run with peaks and citation on success", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => fakeRun("run_W999"),
    } as unknown as Response);

    const tool = buildFetchInstrumentRunTool(mockPool, "http://localhost:8015");
    const result = await tool.execute(mockCtx, { run_id: "run_W999" });

    expect(result.id).toBe("run_W999");
    expect(result.source_system).toBe("waters");
    expect(result.peaks).toHaveLength(1);
    expect(result.citation).toBeDefined();
    expect((result.citation as { source_uri: string }).source_uri).toContain("run_W999");
  });

  it("throws on 404", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "not found",
      statusText: "Not Found",
    } as unknown as Response);

    const tool = buildFetchInstrumentRunTool(mockPool, "http://localhost:8015");
    await expect(tool.execute(mockCtx, { run_id: "run_missing" })).rejects.toThrow();
  });

  it("builds empower URI in citation", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => fakeRun("run_W42"),
    } as unknown as Response);

    const tool = buildFetchInstrumentRunTool(mockPool, "http://localhost:8015", "https://myco.empower.host");
    const result = await tool.execute(mockCtx, { run_id: "run_W42" });

    expect((result.citation as { source_uri: string }).source_uri).toContain("myco.empower.host");
  });
});
