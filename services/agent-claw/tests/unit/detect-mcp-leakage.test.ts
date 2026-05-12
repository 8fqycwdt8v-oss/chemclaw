// Tests for the detect-mcp-leakage post_tool tripwire (review §3.8).
//
// The hook is a counter-only tripwire: it scans MCP responses from
// source-system tools (query_eln_*, fetch_eln_*, query_lims_*,
// fetch_lims_*, query_instrument_*, fetch_instrument_*) for sensitive
// patterns and emits a structured log line with per-pattern counts on
// match. It MUST NOT mutate the response — sources legitimately surface
// the user's own SMILES / NCE codes, and the agent needs them verbatim.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectMcpLeakageHook } from "../../src/core/hooks/detect-mcp-leakage.js";
import type { PostToolPayload } from "../../src/core/types.js";

// Capture logger.info calls without spamming stdout. Module-level singleton
// so the mock instance the hook captures at module load is the same one the
// tests assert against — a getLogger() that returns a fresh object per call
// breaks the mock contract. vi.hoisted() lets the mockLogger be referenced
// from inside vi.mock()'s factory (which Vitest hoists to the top of the
// module before regular imports).
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("../../src/observability/logger.js", () => ({
  getLogger: () => mockLogger,
}));

function makePayload(toolId: string, output: unknown): PostToolPayload {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return {
    ctx: { userEntraId: "test@example.com", scratchpad, seenFactIds },
    toolId,
    input: {},
    output,
  };
}

describe("detectMcpLeakageHook — scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips non-source-system tools", async () => {
    const log = mockLogger;
    const payload = makePayload("predict_reaction_yield", {
      predictions: [
        { rxn_smiles: "CCBr.OCC>>CCOCC", predicted_yield: 80, std: 5 },
      ],
    });
    await detectMcpLeakageHook(payload);
    expect(log.info).not.toHaveBeenCalled();
  });

  it.each([
    "query_eln_experiments",
    "fetch_eln_entry",
    "query_eln_canonical_reactions",
    "fetch_eln_canonical_reaction",
    "query_eln_samples_by_entry",
    "fetch_eln_sample",
    "query_instrument_runs",
    "query_instrument_datasets",
    "fetch_instrument_run",
    "query_lims_samples",
    "fetch_lims_record",
  ])("matches the source-system regex for %s", async (toolId) => {
    const log = mockLogger;
    const payload = makePayload(toolId, {
      items: [{ note: "operator user@example.com tested NCE-12345" }],
    });
    await detectMcpLeakageHook(payload);
    expect(log.info).toHaveBeenCalledOnce();
  });
});

describe("detectMcpLeakageHook — pattern detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits a log line with per-pattern counts when sensitive tokens appear", async () => {
    const log = mockLogger;
    const payload = makePayload("query_eln_experiments", {
      items: [
        {
          smiles: "CC(=O)Oc1ccccc1C(=O)O", // SMILES → matches smiles
          email: "operator@example.com", // email pattern
          project_id: "NCE-12345", // nce_project pattern
          compound: "CMP-987654", // compound_code pattern
        },
      ],
    });
    await detectMcpLeakageHook(payload);
    expect(log.info).toHaveBeenCalledOnce();
    const [meta, msg] = log.info.mock.calls[0];
    expect(msg).toBe("sensitive pattern matched in MCP source-system response");
    expect(meta.event).toBe("mcp_response_pattern_detected");
    expect(meta.tool_id).toBe("query_eln_experiments");
    expect(meta.total_matches).toBeGreaterThanOrEqual(3);
    // Pattern names from the redactor.
    expect(meta.counts).toBeDefined();
  });

  it("does NOT log when the response has no sensitive tokens", async () => {
    const log = mockLogger;
    const payload = makePayload("query_eln_experiments", {
      items: [
        {
          experiment_id: "abc-123",
          status: "completed",
          conditions: "room temp, 18 hours",
        },
      ],
    });
    await detectMcpLeakageHook(payload);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("does NOT mutate the response", async () => {
    const original = {
      items: [{ smiles: "CC(=O)Oc1ccccc1C(=O)O", email: "user@example.com" }],
    };
    const payload = makePayload("query_eln_experiments", original);
    const before = JSON.parse(JSON.stringify(payload.output));
    await detectMcpLeakageHook(payload);
    expect(payload.output).toEqual(before);
    // Specifically: the SMILES is still verbatim.
    expect(
      ((payload.output as Record<string, unknown>).items as Array<Record<string, unknown>>)[0]
        .smiles,
    ).toBe("CC(=O)Oc1ccccc1C(=O)O");
  });

  it("returns {} (no decision contribution to the lifecycle aggregator)", async () => {
    const payload = makePayload("query_eln_experiments", {
      items: [{ smiles: "CC(=O)Oc1ccccc1C(=O)O" }],
    });
    const result = await detectMcpLeakageHook(payload);
    expect(result).toEqual({});
  });

  it("never logs the original token (only counts)", async () => {
    const log = mockLogger;
    const payload = makePayload("query_eln_experiments", {
      items: [{ project_id: "NCE-99999", note: "secret" }],
    });
    await detectMcpLeakageHook(payload);
    const [meta] = log.info.mock.calls[0];
    const serialised = JSON.stringify(meta);
    expect(serialised).not.toContain("NCE-99999");
    expect(serialised).not.toContain("secret"); // not in counts; only patterns + counts surfaced
  });
});

describe("detectMcpLeakageHook — robustness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles a null output without throwing", async () => {
    const log = mockLogger;
    const payload = makePayload("query_eln_experiments", null);
    await detectMcpLeakageHook(payload);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("handles a primitive number output without throwing", async () => {
    const payload = makePayload("query_eln_experiments", 42);
    await expect(detectMcpLeakageHook(payload)).resolves.toEqual({});
  });

  it("handles deeply nested objects", async () => {
    const log = mockLogger;
    const payload = makePayload("query_eln_experiments", {
      a: { b: { c: { d: { e: { f: { note: "NCE-12345" } } } } } },
    });
    await detectMcpLeakageHook(payload);
    expect(log.info).toHaveBeenCalledOnce();
  });
});
