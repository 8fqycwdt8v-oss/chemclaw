// Tests for the compute-result-writer post_tool hook (Tranche 9).
//
// The hook persists chemistry tool outputs to compute_results when:
//   - The tool has a non-null result_schema_id (chemistry tool)
//   - ctx.nceProjectId is non-null
//   - The feature flag chemistry.compute_results.persist is enabled

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";

import { Lifecycle } from "../../../src/core/lifecycle.js";
import { registerComputeResultWriterHook } from "../../../src/core/hooks/compute-result-writer.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import { defineTool, type Tool } from "../../../src/tools/tool.js";
import type { PostToolPayload, ToolContext } from "../../../src/core/types.js";

function makePool(): Pool {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
  } as unknown as Pool;
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userEntraId: "user-1",
    orgId: null,
    nceProjectId: "00000000-0000-0000-0000-000000000aaa",
    scratchpad: new Map(),
    seenFactIds: new Set(),
    ...overrides,
  };
}

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  const chemTool: Tool = defineTool({
    id: "propose_retrosynthesis",
    description: "retrosynthesis",
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async () => ({}),
    result_schema_id: "retrosynthesis.v1",
  });
  const internalTool: Tool = defineTool({
    id: "manage_todos",
    description: "internal",
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async () => ({}),
    is_internal: true,
  });
  const noSchemaTool: Tool = defineTool({
    id: "search_knowledge",
    description: "search",
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async () => ({}),
  });
  reg.register(chemTool);
  reg.register(internalTool);
  reg.register(noSchemaTool);
  return reg;
}

function basePayload(overrides: Partial<PostToolPayload> = {}): PostToolPayload {
  return {
    ctx: makeCtx(),
    toolId: "propose_retrosynthesis",
    input: { smiles: "CC(=O)O", max_depth: 3 },
    output: {
      source: "askcos",
      routes_askcos: [{ steps: [], total_score: 0.87, depth: 2 }],
    },
    invocationId: "00000000-0000-0000-0000-000000000001",
    durationMs: 500,
    ...overrides,
  };
}

describe("compute-result-writer hook", () => {
  let pool: Pool;
  let lifecycle: Lifecycle;
  let registry: ToolRegistry;
  let isFeatureEnabled: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pool = makePool();
    lifecycle = new Lifecycle();
    registry = makeRegistry();
    isFeatureEnabled = vi.fn(async () => true);
    registerComputeResultWriterHook(lifecycle, { pool, registry, isFeatureEnabled });
  });

  it("inserts into compute_results for a chemistry tool when flag is on", async () => {
    await lifecycle.dispatch("post_tool", basePayload());
    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, args] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO compute_results");
    expect(sql).toContain("ON CONFLICT ON CONSTRAINT compute_results_cache_key");
    // tool_id
    expect(args[0]).toBe("propose_retrosynthesis");
    // nce_project_id
    expect(args[2]).toBe("00000000-0000-0000-0000-000000000aaa");
    // model_id defaults to '' (not present in output)
    expect(args[3]).toBe("");
    // user_entra_id
    expect(args[7]).toBe("user-1");
  });

  it("skips when feature flag is disabled", async () => {
    isFeatureEnabled.mockResolvedValueOnce(false);
    await lifecycle.dispatch("post_tool", basePayload());
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("skips when ctx.nceProjectId is null", async () => {
    await lifecycle.dispatch("post_tool", basePayload({ ctx: makeCtx({ nceProjectId: null }) }));
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("skips for tools without result_schema_id", async () => {
    await lifecycle.dispatch("post_tool", basePayload({ toolId: "search_knowledge" }));
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("skips for internal tools", async () => {
    await lifecycle.dispatch("post_tool", basePayload({ toolId: "manage_todos" }));
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("skips for unknown tool id (no registry entry)", async () => {
    await lifecycle.dispatch("post_tool", basePayload({ toolId: "some_forged_tool" }));
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("extracts model_id from yield prediction output", async () => {
    const output = {
      predictions: [{ rxn_smiles: "A>>B", ensemble_mean: 72.5, ensemble_std: 6.1 }],
      model_id: "proj-abc-v2",
      n_train: 300,
      used_global_fallback: false,
    };
    await lifecycle.dispatch("post_tool", basePayload({ output }));
    const [, args] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(args[3]).toBe("proj-abc-v2");
  });

  it("extracts tool_confidence from retrosynthesis route total_score", async () => {
    await lifecycle.dispatch("post_tool", basePayload());
    const [, args] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    // tool_confidence is at index 5 (0-based: $6 in SQL)
    expect(args[5]).toBeCloseTo(0.87, 5);
  });

  it("extracts tool_confidence from ensemble_mean (yield prediction)", async () => {
    const output = {
      predictions: [{ rxn_smiles: "A>>B", ensemble_mean: 80.0, ensemble_std: 4.0 }],
      model_id: null,
      n_train: 100,
      used_global_fallback: false,
    };
    await lifecycle.dispatch("post_tool", basePayload({ output }));
    const [, args] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(args[5]).toBeCloseTo(0.8, 5);
  });

  it("produces null tool_confidence when output has no recognisable score", async () => {
    const output = { compound: "caffeine", inchikey: "XYZ123" };
    await lifecycle.dispatch("post_tool", basePayload({ output }));
    const [, args] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(args[5]).toBeNull();
  });

  it("input_hash is deterministic regardless of object key order", async () => {
    const inputA = { smiles: "CC", max_depth: 3 };
    const inputB = { max_depth: 3, smiles: "CC" };
    await lifecycle.dispatch("post_tool", basePayload({ input: inputA }));
    await lifecycle.dispatch("post_tool", basePayload({ input: inputB }));
    const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls as [string, unknown[]][];
    // Both hashes should be identical (canonical key-sort).
    expect(calls[0][1][1]).toBe(calls[1][1][1]);
  });

  it("swallows DB errors without failing the turn", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("connection lost"));
    // Should not throw.
    await expect(lifecycle.dispatch("post_tool", basePayload())).resolves.not.toThrow();
  });
});
