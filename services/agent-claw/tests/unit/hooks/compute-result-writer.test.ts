// Tests for the compute-result-writer post_tool hook (Tranche 9).
//
// The hook persists chemistry tool outputs to compute_results when:
//   - The tool has a non-null result_schema_id (chemistry tool)
//   - ctx.nceProjectId is non-null
//   - The feature flag chemistry.compute_results.persist is enabled
//
// DB writes go through withUserContext (FORCE RLS on compute_results requires
// app.current_user_entra_id to be set). The module is mocked so unit tests
// do not need a real Postgres connection.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";

import { Lifecycle } from "../../../src/core/lifecycle.js";
import { registerComputeResultWriterHook } from "../../../src/core/hooks/compute-result-writer.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import { defineTool, type Tool } from "../../../src/tools/tool.js";
import type { PostToolPayload, ToolContext } from "../../../src/core/types.js";

// Mock withUserContext so tests don't need a real pool.
// The mock forwards the fn call to a stub client whose query we can inspect.
vi.mock("../../../src/db/with-user-context.js", () => ({
  withUserContext: vi.fn(async (
    _pool: unknown,
    _user: unknown,
    fn: (c: { query: ReturnType<typeof vi.fn> }) => Promise<void>,
  ) => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) };
    await fn(client);
    return undefined;
  }),
}));

function makePool(): Pool {
  // Pool is passed to withUserContext but the mock ignores it.
  return {} as unknown as Pool;
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
  let withUserContextMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    pool = makePool();
    lifecycle = new Lifecycle();
    registry = makeRegistry();
    isFeatureEnabled = vi.fn(async () => true);
    registerComputeResultWriterHook(lifecycle, { pool, registry, isFeatureEnabled });

    const ucModule = await import("../../../src/db/with-user-context.js");
    withUserContextMock = vi.mocked(ucModule.withUserContext);
    withUserContextMock.mockClear();
  });

  it("calls withUserContext (RLS) and inserts into compute_results for a chemistry tool", async () => {
    let clientQuery!: ReturnType<typeof vi.fn>;
    withUserContextMock.mockImplementationOnce(async (_pool, _user, fn) => {
      clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
      await fn({ query: clientQuery });
    });

    await lifecycle.dispatch("post_tool", basePayload());

    expect(withUserContextMock).toHaveBeenCalledOnce();
    expect(withUserContextMock.mock.calls[0][1]).toBe("user-1");
    expect(clientQuery).toHaveBeenCalledOnce();

    const [sql, args] = clientQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO compute_results");
    expect(sql).toContain("ON CONFLICT ON CONSTRAINT compute_results_cache_key");
    expect(args[0]).toBe("propose_retrosynthesis");
    expect(args[2]).toBe("00000000-0000-0000-0000-000000000aaa");
    expect(args[3]).toBe("");
    expect(args[7]).toBe("user-1");
  });

  it("skips when feature flag is disabled", async () => {
    isFeatureEnabled.mockResolvedValueOnce(false);
    await lifecycle.dispatch("post_tool", basePayload());
    expect(withUserContextMock).not.toHaveBeenCalled();
  });

  it("skips when ctx.nceProjectId is null", async () => {
    await lifecycle.dispatch("post_tool", basePayload({ ctx: makeCtx({ nceProjectId: null }) }));
    expect(withUserContextMock).not.toHaveBeenCalled();
  });

  it("skips for tools without result_schema_id", async () => {
    await lifecycle.dispatch("post_tool", basePayload({ toolId: "search_knowledge" }));
    expect(withUserContextMock).not.toHaveBeenCalled();
  });

  it("skips for internal tools", async () => {
    await lifecycle.dispatch("post_tool", basePayload({ toolId: "manage_todos" }));
    expect(withUserContextMock).not.toHaveBeenCalled();
  });

  it("skips for unknown tool id (no registry entry)", async () => {
    await lifecycle.dispatch("post_tool", basePayload({ toolId: "some_forged_tool" }));
    expect(withUserContextMock).not.toHaveBeenCalled();
  });

  it("extracts model_id from yield prediction output", async () => {
    let clientQuery!: ReturnType<typeof vi.fn>;
    withUserContextMock.mockImplementationOnce(async (_pool, _user, fn) => {
      clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
      await fn({ query: clientQuery });
    });

    const output = {
      predictions: [{ rxn_smiles: "A>>B", ensemble_mean: 72.5, ensemble_std: 6.1 }],
      model_id: "proj-abc-v2",
      n_train: 300,
      used_global_fallback: false,
    };
    await lifecycle.dispatch("post_tool", basePayload({ output }));
    const [, args] = clientQuery.mock.calls[0] as [string, unknown[]];
    expect(args[3]).toBe("proj-abc-v2");
  });

  it("extracts tool_confidence from retrosynthesis route total_score", async () => {
    let clientQuery!: ReturnType<typeof vi.fn>;
    withUserContextMock.mockImplementationOnce(async (_pool, _user, fn) => {
      clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
      await fn({ query: clientQuery });
    });

    await lifecycle.dispatch("post_tool", basePayload());
    const [, args] = clientQuery.mock.calls[0] as [string, unknown[]];
    expect(args[5]).toBeCloseTo(0.87, 5);
  });

  it("extracts tool_confidence from ensemble_mean (yield prediction)", async () => {
    let clientQuery!: ReturnType<typeof vi.fn>;
    withUserContextMock.mockImplementationOnce(async (_pool, _user, fn) => {
      clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
      await fn({ query: clientQuery });
    });

    const output = {
      predictions: [{ rxn_smiles: "A>>B", ensemble_mean: 80.0, ensemble_std: 4.0 }],
      model_id: null,
      n_train: 100,
      used_global_fallback: false,
    };
    await lifecycle.dispatch("post_tool", basePayload({ output }));
    const [, args] = clientQuery.mock.calls[0] as [string, unknown[]];
    expect(args[5]).toBeCloseTo(0.8, 5);
  });

  it("produces null tool_confidence when output has no recognisable score", async () => {
    let clientQuery!: ReturnType<typeof vi.fn>;
    withUserContextMock.mockImplementationOnce(async (_pool, _user, fn) => {
      clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
      await fn({ query: clientQuery });
    });

    const output = { compound: "caffeine", inchikey: "XYZ123" };
    await lifecycle.dispatch("post_tool", basePayload({ output }));
    const [, args] = clientQuery.mock.calls[0] as [string, unknown[]];
    expect(args[5]).toBeNull();
  });

  it("input_hash is deterministic regardless of object key order", async () => {
    const hashes: unknown[] = [];
    withUserContextMock.mockImplementation(async (_pool, _user, fn) => {
      const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
      await fn({ query: clientQuery });
      hashes.push(clientQuery.mock.calls[0][1][1]);
    });

    const inputA = { smiles: "CC", max_depth: 3 };
    const inputB = { max_depth: 3, smiles: "CC" };
    await lifecycle.dispatch("post_tool", basePayload({ input: inputA }));
    await lifecycle.dispatch("post_tool", basePayload({ input: inputB }));

    expect(hashes[0]).toBe(hashes[1]);
  });

  it("swallows withUserContext errors without failing the turn", async () => {
    withUserContextMock.mockRejectedValueOnce(new Error("connection lost"));
    await expect(lifecycle.dispatch("post_tool", basePayload())).resolves.not.toThrow();
  });
});
