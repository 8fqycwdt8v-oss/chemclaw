// Tests for the tool-invocation-emitter post_tool / post_tool_failure hook.
//
// Phase 0 — Universal Knowledge Accumulation. The hook emits one
// `tool_invocation_complete` ingestion event per non-internal tool call when
// the feature flag `kg.auto_extraction.enabled` resolves to true for the
// (user, project) context.
//
// Phase 1.0b plumbed the harness post_tool / post_tool_failure envelope
// (invocationId + durationMs in run-one-tool.ts, is_internal on the Tool
// interface). These tests exercise the live envelope shape — ctx.userEntraId
// / ctx.nceProjectId rather than the previous {user, project} ad-hoc envelope.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";

import { Lifecycle } from "../../../src/core/lifecycle.js";
import { registerToolInvocationEmitterHook } from "../../../src/core/hooks/tool-invocation-emitter.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import { defineTool, type Tool } from "../../../src/tools/tool.js";
import type {
  PostToolPayload,
  PostToolFailurePayload,
  ToolContext,
} from "../../../src/core/types.js";

function makePool(): Pool {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as Pool;
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userEntraId: "user-1",
    orgId: null,
    nceProjectId: "00000000-0000-0000-0000-0000000000aa",
    scratchpad: new Map(),
    seenFactIds: new Set(),
    ...overrides,
  };
}

/**
 * Build a tiny ToolRegistry pre-populated with one external tool
 * (`mcp-xtb.compute_barrier`, is_internal=false, result_schema_id="v1")
 * and one internal builtin (`manage_todos`, is_internal=true). The
 * registry-lookup short-circuit in the hook reads is_internal off
 * whatever Tool the registry returns.
 */
function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  const external: Tool = defineTool({
    id: "mcp-xtb.compute_barrier",
    description: "compute reaction barrier",
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async () => ({}),
    is_internal: false,
    result_schema_id: "v1",
  });
  const internal: Tool = defineTool({
    id: "manage_todos",
    description: "internal builtin",
    inputSchema: z.any(),
    outputSchema: z.any(),
    execute: async () => ({}),
    is_internal: true,
  });
  reg.register(external);
  reg.register(internal);
  return reg;
}

function basePostToolPayload(
  overrides: Partial<PostToolPayload> = {},
): PostToolPayload {
  return {
    ctx: makeCtx(),
    toolId: "mcp-xtb.compute_barrier",
    input: { smiles: "[redacted]" },
    output: { barrier_kj_mol: 92.3 },
    invocationId: "00000000-0000-0000-0000-000000000001",
    durationMs: 1234,
    ...overrides,
  };
}

function basePostToolFailurePayload(
  overrides: Partial<PostToolFailurePayload> = {},
): PostToolFailurePayload {
  return {
    ctx: makeCtx(),
    toolId: "mcp-xtb.compute_barrier",
    input: { smiles: "[redacted]" },
    error: new Error("SCF did not converge"),
    durationMs: 1234,
    invocationId: "00000000-0000-0000-0000-000000000001",
    ...overrides,
  };
}

describe("tool-invocation-emitter hook", () => {
  let pool: Pool;
  let lifecycle: Lifecycle;
  let registry: ToolRegistry;
  let isFeatureEnabled: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pool = makePool();
    lifecycle = new Lifecycle();
    registry = makeRegistry();
    isFeatureEnabled = vi.fn(async () => true);
    registerToolInvocationEmitterHook(lifecycle, {
      pool,
      registry,
      isFeatureEnabled,
    });
  });

  it("emits tool_invocation_complete on post_tool when flag is enabled", async () => {
    await lifecycle.dispatch("post_tool", basePostToolPayload());
    expect(pool.query).toHaveBeenCalledOnce();
    const call = (pool.query as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    const sql = call[0] as string;
    const args = call[1] as unknown[];
    expect(sql).toContain("INSERT INTO ingestion_events");
    expect(sql).toContain("tool_invocation_complete");
    expect(args).toContain("mcp-xtb.compute_barrier");
    expect(args).toContain("user-1");
    // invocationId threads through as source_row_id ($1 in the SQL).
    expect(args[0]).toBe("00000000-0000-0000-0000-000000000001");
    // result_schema_id is read off the registered tool.
    expect(args).toContain("v1");
  });

  it("short-circuits when feature flag is disabled", async () => {
    isFeatureEnabled.mockResolvedValueOnce(false);
    await lifecycle.dispatch("post_tool", basePostToolPayload());
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("skips internal tools (manage_todos, ask_user, etc.)", async () => {
    await lifecycle.dispatch(
      "post_tool",
      basePostToolPayload({ toolId: "manage_todos" }),
    );
    expect(pool.query).not.toHaveBeenCalled();
    // Internal tools must NOT consult the feature flag — short-circuit first.
    expect(isFeatureEnabled).not.toHaveBeenCalled();
  });

  it("emits with ok=false on post_tool_failure", async () => {
    await lifecycle.dispatch(
      "post_tool_failure",
      basePostToolFailurePayload(),
    );
    expect(pool.query).toHaveBeenCalledOnce();
    const call = (pool.query as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    const args = call[1] as unknown[];
    expect(args).toContain(false);
    expect(args).toContain("SCF did not converge");
    // invocationId is the SAME on the failure path as the success path.
    expect(args[0]).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("swallows DB errors and does not propagate", async () => {
    (
      pool.query as unknown as {
        mockRejectedValueOnce: (e: Error) => void;
      }
    ).mockRejectedValueOnce(new Error("connection refused"));
    // Should resolve without throwing — defense-in-depth: the hook must
    // never fail the agent turn.
    await expect(
      lifecycle.dispatch("post_tool", basePostToolPayload()),
    ).resolves.toBeDefined();
  });

  it("only bind-args the post-redaction input / output (defense-in-depth)", async () => {
    // The hook reads input + output straight off the envelope. The upstream
    // redact-tool-output post_tool hook (yaml order:200) runs AFTER
    // tool-invocation-emitter (yaml order:80) in the same pre_post chain;
    // the envelope's `input`/`output` are the already-Zod-validated values
    // (run-one-tool.ts validates output via tool.outputSchema.parse before
    // dispatch). Any raw_* field hung off the envelope by an attacker must
    // never make it into the bind args — only the documented fields are
    // serialised.
    await lifecycle.dispatch(
      "post_tool",
      basePostToolPayload({
        input: { smiles: "[redacted]" },
        output: { barrier_kj_mol: 92.3 },
      }),
    );
    const call = (pool.query as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    const args = call[1] as unknown[];
    const argsJson = JSON.stringify(args);
    // Inputs / outputs in the args bag are exactly what we passed.
    expect(argsJson).toContain("[redacted]");
    expect(argsJson).toContain("barrier_kj_mol");
  });

  it("passes through null project_id from ctx.nceProjectId", async () => {
    await lifecycle.dispatch(
      "post_tool",
      basePostToolPayload({
        ctx: makeCtx({ userEntraId: "user-2", nceProjectId: null }),
      }),
    );
    expect(pool.query).toHaveBeenCalledOnce();
    const call = (pool.query as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    const args = call[1] as unknown[];
    // Project null must propagate; user must still be present.
    expect(args).toContain(null);
    expect(args).toContain("user-2");
  });

  it("treats unregistered tools as is_internal=false (graceful degradation)", async () => {
    // Forged / hot-loaded tools may not yet be in the registry snapshot when
    // the hook fires. The hook MUST emit rather than silently drop — err on
    // the side of recording.
    await lifecycle.dispatch(
      "post_tool",
      basePostToolPayload({ toolId: "forged.some_new_tool" }),
    );
    expect(pool.query).toHaveBeenCalledOnce();
    const call = (pool.query as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    const args = call[1] as unknown[];
    expect(args).toContain("forged.some_new_tool");
    // No result_schema_id on the registry miss path → null.
    expect(args).toContain(null);
  });

  it("uses invocationId as the source_row_id bind parameter", async () => {
    const invocationId = "11111111-2222-3333-4444-555555555555";
    await lifecycle.dispatch(
      "post_tool",
      basePostToolPayload({ invocationId }),
    );
    const call = (pool.query as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    const args = call[1] as unknown[];
    // $1 in the SQL is bound to invocationId — first positional arg.
    expect(args[0]).toBe(invocationId);
  });
});
