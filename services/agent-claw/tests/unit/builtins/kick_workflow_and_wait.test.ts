// Tests for kick_workflow_and_wait — start a workflow run and poll until
// terminal. Uses a fake Pool that returns a script of inspectRun outcomes
// so we can simulate succeeded / failed / cancelled / timed_out paths
// without a real Postgres + workflow_engine.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { buildKickWorkflowAndWaitTool } from "../../../src/tools/builtins/kick_workflow_and_wait.js";
import * as workflowsClient from "../../../src/core/workflows/client.js";
import { makeCtx } from "../../helpers/make-ctx.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function fakePool(): Pool {
  return { query: vi.fn() } as unknown as Pool;
}

function buildInspect(status: string, opts?: {
  output?: Record<string, unknown> | null;
  events?: Array<{
    id: number;
    run_id: string;
    seq: number;
    kind: string;
    step_id: string | null;
    payload: Record<string, unknown>;
    created_at: string;
  }>;
}) {
  return {
    run: {
      id: "00000000-0000-0000-0000-000000000001",
      workflow_id: "00000000-0000-0000-0000-0000000000aa",
      parent_run_id: null,
      session_id: null,
      status,
      input: {},
      output: opts?.output ?? null,
      started_at: null,
      finished_at: status === "succeeded" ? "2026-05-08T00:00:00Z" : null,
      paused_at: null,
      created_by: "u1",
      created_at: "2026-05-08T00:00:00Z",
    },
    state: null,
    events: opts?.events ?? [],
  };
}

describe("kick_workflow_and_wait", () => {
  it("returns immediately when the run is already in a terminal state", async () => {
    vi.spyOn(workflowsClient, "startRun").mockResolvedValue("run-1");
    vi.spyOn(workflowsClient, "inspectRun").mockResolvedValue(
      buildInspect("succeeded", { output: { result: 42 } }),
    );

    const tool = buildKickWorkflowAndWaitTool(fakePool());
    const out = await tool.execute(makeCtx(), {
      workflow_id: "00000000-0000-0000-0000-0000000000aa",
      input: {},
      timeout_seconds: 10,
      poll_interval_seconds: 1,
    });

    expect(out.status).toBe("succeeded");
    expect(out.run_id).toBe("run-1");
    expect(out.output).toEqual({ result: 42 });
    expect(out.last_failure).toBeNull();
  });

  it("polls until the run succeeds and returns the final output", async () => {
    vi.spyOn(workflowsClient, "startRun").mockResolvedValue("run-2");
    const inspect = vi.spyOn(workflowsClient, "inspectRun");
    inspect.mockResolvedValueOnce(buildInspect("running"));
    inspect.mockResolvedValueOnce(buildInspect("running"));
    inspect.mockResolvedValueOnce(
      buildInspect("succeeded", { output: { ok: true } }),
    );

    const tool = buildKickWorkflowAndWaitTool(fakePool());
    const out = await tool.execute(makeCtx(), {
      workflow_id: "00000000-0000-0000-0000-0000000000aa",
      input: {},
      timeout_seconds: 10,
      poll_interval_seconds: 1,
    });

    expect(out.status).toBe("succeeded");
    expect(out.output).toEqual({ ok: true });
    expect(inspect).toHaveBeenCalledTimes(3);
  });

  it("returns failed + last_failure when the engine reports step_failed", async () => {
    vi.spyOn(workflowsClient, "startRun").mockResolvedValue("run-3");
    vi.spyOn(workflowsClient, "inspectRun").mockResolvedValue(
      buildInspect("failed", {
        events: [
          {
            id: 1, run_id: "run-3", seq: 1, kind: "step_started",
            step_id: "s1", payload: {}, created_at: "t",
          },
          {
            id: 2, run_id: "run-3", seq: 2, kind: "step_failed",
            step_id: "s1",
            payload: { error: "tool exploded" },
            created_at: "t",
          },
        ],
      }),
    );

    const tool = buildKickWorkflowAndWaitTool(fakePool());
    const out = await tool.execute(makeCtx(), {
      workflow_id: "00000000-0000-0000-0000-0000000000aa",
      input: {},
      timeout_seconds: 10,
      poll_interval_seconds: 1,
    });

    expect(out.status).toBe("failed");
    expect(out.last_failure).toEqual({ step_id: "s1", error: "tool exploded" });
  });

  it("returns timed_out when terminal status not reached within budget", async () => {
    vi.spyOn(workflowsClient, "startRun").mockResolvedValue("run-4");
    vi.spyOn(workflowsClient, "inspectRun").mockResolvedValue(
      buildInspect("running"),
    );

    const tool = buildKickWorkflowAndWaitTool(fakePool());
    const out = await tool.execute(makeCtx(), {
      workflow_id: "00000000-0000-0000-0000-0000000000aa",
      input: {},
      // timeout is 1s; pollInterval 1s — first inspect fires, then we'd
      // wait pollMs to next iteration but Date.now()+pollMs > deadline,
      // so we return timed_out without sleeping the full second.
      timeout_seconds: 1,
      poll_interval_seconds: 1,
    });

    expect(out.status).toBe("timed_out");
    expect(out.output).toBeNull();
  });

  it("respects ctx.signal abort", async () => {
    vi.spyOn(workflowsClient, "startRun").mockResolvedValue("run-5");
    vi.spyOn(workflowsClient, "inspectRun").mockResolvedValue(
      buildInspect("running"),
    );

    const tool = buildKickWorkflowAndWaitTool(fakePool());
    const ctrl = new AbortController();
    ctrl.abort();
    const ctx = { ...makeCtx(), signal: ctrl.signal };

    await expect(
      tool.execute(ctx, {
        workflow_id: "00000000-0000-0000-0000-0000000000aa",
        input: {},
        timeout_seconds: 10,
        poll_interval_seconds: 1,
      }),
    ).rejects.toThrow(/aborted/);
  });
});
