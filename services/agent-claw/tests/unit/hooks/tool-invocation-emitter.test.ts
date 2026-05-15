// Tests for the tool-invocation-emitter post_tool / post_tool_failure hook.
//
// Phase 0 — Universal Knowledge Accumulation. The hook emits one
// `tool_invocation_complete` ingestion event per non-internal tool call when
// the feature flag `kg.auto_extraction.enabled` resolves to true for the
// (user, project) context.
//
// Task 7 ships the hook + YAML + tests; the loader wiring happens in Task 8.
// These tests therefore drive the hook through a fresh `Lifecycle` instance
// constructed directly (no loadHooks) and rely on the runtime payload-shape
// erasure to feed the hook the envelope it expects (cast through `unknown`).

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Pool } from "pg";

import { Lifecycle } from "../../../src/core/lifecycle.js";
import { registerToolInvocationEmitterHook } from "../../../src/core/hooks/tool-invocation-emitter.js";
import type { PostToolPayload } from "../../../src/core/types.js";

function makePool(): Pool {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as Pool;
}

// The hook's expected envelope. The lifecycle's typed `dispatch` insists on
// `PostToolPayload`, so the tests cast through unknown — runtime is what we
// actually exercise here. Task 8 will plumb the harness to construct this
// envelope on dispatch.
const baseInput = {
  tool: {
    name: "mcp-xtb.compute_barrier",
    is_internal: false,
    result_schema_id: "v1",
  },
  ctx: { user: "user-1", project: "00000000-0000-0000-0000-0000000000aa" },
  invocation_id: "00000000-0000-0000-0000-000000000001",
  redacted_args: { smiles: "[redacted]" },
  redacted_result: { barrier_kj_mol: 92.3 },
  duration_ms: 1234,
  ok: true,
  error: null,
};

function dispatchPostTool(lifecycle: Lifecycle, input: unknown) {
  return lifecycle.dispatch("post_tool", input as PostToolPayload);
}

function dispatchPostToolFailure(lifecycle: Lifecycle, input: unknown) {
  return lifecycle.dispatch(
    "post_tool_failure",
    input as Parameters<Lifecycle["dispatch"]>[1],
  );
}

describe("tool-invocation-emitter hook", () => {
  let pool: Pool;
  let lifecycle: Lifecycle;
  let isFeatureEnabled: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pool = makePool();
    lifecycle = new Lifecycle();
    isFeatureEnabled = vi.fn(async () => true);
    registerToolInvocationEmitterHook(lifecycle, { pool, isFeatureEnabled });
  });

  it("emits tool_invocation_complete on post_tool when flag is enabled", async () => {
    await dispatchPostTool(lifecycle, baseInput);
    expect(pool.query).toHaveBeenCalledOnce();
    const call = (pool.query as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    const sql = call[0] as string;
    const args = call[1] as unknown[];
    expect(sql).toContain("INSERT INTO ingestion_events");
    expect(sql).toContain("tool_invocation_complete");
    expect(args).toContain("mcp-xtb.compute_barrier");
    expect(args).toContain("user-1");
    expect(args).toContain("00000000-0000-0000-0000-000000000001");
  });

  it("short-circuits when feature flag is disabled", async () => {
    isFeatureEnabled.mockResolvedValueOnce(false);
    await dispatchPostTool(lifecycle, baseInput);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("skips internal tools (manage_todos, ask_user, etc.)", async () => {
    await dispatchPostTool(lifecycle, {
      ...baseInput,
      tool: { ...baseInput.tool, is_internal: true },
    });
    expect(pool.query).not.toHaveBeenCalled();
    // Internal tools must NOT consult the feature flag — short-circuit first.
    expect(isFeatureEnabled).not.toHaveBeenCalled();
  });

  it("emits with ok=false on post_tool_failure", async () => {
    await dispatchPostToolFailure(lifecycle, {
      ...baseInput,
      ok: false,
      error: "SCF did not converge",
      redacted_result: null,
    });
    expect(pool.query).toHaveBeenCalledOnce();
    const call = (pool.query as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    const args = call[1] as unknown[];
    expect(args).toContain(false);
    expect(args).toContain("SCF did not converge");
  });

  it("swallows DB errors and does not propagate", async () => {
    (
      pool.query as unknown as {
        mockRejectedValueOnce: (e: Error) => void;
      }
    ).mockRejectedValueOnce(new Error("connection refused"));
    // Should resolve without throwing — defense-in-depth: the hook must
    // never fail the agent turn.
    await expect(dispatchPostTool(lifecycle, baseInput)).resolves.toBeDefined();
  });

  it("never reads raw args from the input (defense-in-depth)", async () => {
    const inputWithRaw = {
      ...baseInput,
      // raw_args / raw_result are present on the wire envelope only as a
      // theoretical leak channel; the hook MUST read only `redacted_args` /
      // `redacted_result` and never touch the raw_* fields.
      raw_args: { secret_smiles: "REAL_SECRET" },
      raw_result: { secret_barrier: "REAL_SECRET_RESULT" },
    };
    await dispatchPostTool(lifecycle, inputWithRaw);
    const call = (pool.query as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    const args = call[1] as unknown[];
    const argsJson = JSON.stringify(args);
    expect(argsJson).not.toContain("REAL_SECRET");
    expect(argsJson).not.toContain("REAL_SECRET_RESULT");
  });

  it("passes through nullable redacted_result and project", async () => {
    await dispatchPostTool(lifecycle, {
      ...baseInput,
      ctx: { user: "user-2", project: null },
      redacted_result: null,
    });
    expect(pool.query).toHaveBeenCalledOnce();
    const call = (pool.query as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    const args = call[1] as unknown[];
    // Project null must propagate; user must still be present.
    expect(args).toContain(null);
    expect(args).toContain("user-2");
  });
});
