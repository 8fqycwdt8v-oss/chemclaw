// Host tests — drive MontyHost end-to-end with a fake child adapter that
// loops the protocol in-process. Verifies happy path, external_function
// dispatch, max_external_calls cap, wall-time timeout, child-crash, and
// script error handling.

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { EventEmitter } from "node:events";
import { defineTool } from "../../../../src/tools/tool.js";
import { Lifecycle } from "../../../../src/core/lifecycle.js";
import { MontyHost } from "../../../../src/runtime/monty/host.js";
import type {
  MontyChild,
  MontyChildEvents,
  MontyChildFactory,
} from "../../../../src/runtime/monty/child-adapter.js";
import type {
  ChildToHostFrameT,
  HostToChildFrameT,
} from "../../../../src/runtime/monty/protocol.js";
import type { Tool } from "../../../../src/tools/tool.js";
import { makeCtx } from "../../../helpers/make-ctx.js";

// ---------------------------------------------------------------------------
// FakeChild — scriptable child for tests. The behaviour is a list of frames
// to emit on .send() being called with a particular type, plus an optional
// startup behaviour that fires immediately after construction.
// ---------------------------------------------------------------------------

interface FakeChildBehavior {
  /** Called after construction; emit the initial "ready" frame here. */
  onStart?: (emit: (frame: ChildToHostFrameT) => void) => void;
  /** Per-frame reaction. The fake delegates to `react` on every host→child send. */
  react?: (
    frame: HostToChildFrameT,
    emit: (frame: ChildToHostFrameT) => void,
    kill: () => void,
  ) => void;
}

class FakeChild extends EventEmitter implements MontyChild {
  private _alive = true;
  constructor(private readonly behavior: FakeChildBehavior) {
    super();
    setImmediate(() => {
      this.behavior.onStart?.(this._emit);
    });
  }
  private _emit = (frame: ChildToHostFrameT): void => {
    if (!this._alive) return;
    this.emit("frame", frame);
  };
  send(frame: HostToChildFrameT): void {
    if (!this._alive) throw new Error("FakeChild send after kill");
    setImmediate(() => {
      this.behavior.react?.(frame, this._emit, () => this.kill());
    });
  }
  kill(): void {
    if (!this._alive) return;
    this._alive = false;
    setImmediate(() => {
      this.emit("exit", 0, null);
    });
  }
  get alive(): boolean {
    return this._alive;
  }
  override on<K extends keyof MontyChildEvents>(
    event: K,
    listener: MontyChildEvents[K],
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override off<K extends keyof MontyChildEvents>(
    event: K,
    listener: MontyChildEvents[K],
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

function fakeFactory(behavior: FakeChildBehavior): MontyChildFactory {
  return () => new FakeChild(behavior);
}

function buildEchoTool(id: string): Tool {
  return defineTool({
    id,
    description: id,
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ echoed: z.string() }),
    annotations: { readOnly: true },
    execute: async (_ctx, input) => ({ echoed: input.value.toUpperCase() }),
  });
}

function makeRegistry(tools: Tool[]): { get(id: string): Tool | undefined } {
  const map = new Map(tools.map((t) => [t.id, t]));
  return { get: (id) => map.get(id) };
}

const baseRunOpts = {
  runId: "r1",
  script: "noop",
  allowedTools: [],
  inputs: {},
  expectedOutputs: ["x"],
  wallTimeMs: 5_000,
  maxExternalCalls: 8,
  ctx: makeCtx(),
};

describe("MontyHost.run", () => {
  it("returns ok with outputs on a clean script run", async () => {
    const lifecycle = new Lifecycle();
    const host = new MontyHost({
      childFactory: fakeFactory({
        onStart: (emit) => emit({ type: "ready" }),
        react: (frame, emit) => {
          if (frame.type === "start") {
            emit({ type: "log", stream: "stdout", message: "hello" });
            emit({ type: "result", run_id: frame.run_id, outputs: { x: 42 } });
          }
        },
      }),
      registry: makeRegistry([]),
      lifecycle,
    });
    const result = await host.run(baseRunOpts);
    expect(result.outcome.kind).toBe("ok");
    if (result.outcome.kind === "ok") {
      expect(result.outcome.outputs).toEqual({ x: 42 });
    }
    expect(result.stdout).toContain("hello");
    expect(result.externalCalls).toEqual([]);
  });

  it("routes external_function calls through runOneTool", async () => {
    const tool = buildEchoTool("echo");
    const lifecycle = new Lifecycle();
    let toolValue: unknown;

    const host = new MontyHost({
      childFactory: fakeFactory({
        onStart: (emit) => emit({ type: "ready" }),
        react: (frame, emit) => {
          if (frame.type === "start") {
            emit({
              type: "external_call",
              id: 1,
              name: "echo",
              args: { value: "abc" },
            });
            return;
          }
          if (frame.type === "external_response") {
            toolValue = frame.value;
            emit({
              type: "result",
              run_id: "r1",
              outputs: { x: frame.value },
            });
          }
        },
      }),
      registry: makeRegistry([tool]),
      lifecycle,
    });

    const result = await host.run({
      ...baseRunOpts,
      allowedTools: ["echo"],
    });

    expect(result.outcome.kind).toBe("ok");
    expect(toolValue).toEqual({ echoed: "ABC" });
    expect(result.externalCalls).toEqual([
      expect.objectContaining({ toolId: "echo", ok: true }),
    ]);
  });

  it("enforces max_external_calls — extra calls return ok=false", async () => {
    const tool = buildEchoTool("echo");
    const lifecycle = new Lifecycle();
    let firstResponse: unknown;
    let secondResponse: unknown;

    // Emit sequentially: real Monty would block on each external_function
    // returning before the next one. Doing it here lets us assert ordering
    // and lets the cap test see both responses deterministically.
    const host = new MontyHost({
      childFactory: fakeFactory({
        onStart: (emit) => emit({ type: "ready" }),
        react: (frame, emit) => {
          if (frame.type === "start") {
            emit({
              type: "external_call",
              id: 1,
              name: "echo",
              args: { value: "first" },
            });
            return;
          }
          if (frame.type === "external_response") {
            if (firstResponse === undefined) {
              firstResponse = frame;
              emit({
                type: "external_call",
                id: 2,
                name: "echo",
                args: { value: "second" },
              });
              return;
            }
            secondResponse = frame;
            emit({ type: "result", run_id: "r1", outputs: { x: 0 } });
          }
        },
      }),
      registry: makeRegistry([tool]),
      lifecycle,
    });

    const result = await host.run({
      ...baseRunOpts,
      allowedTools: ["echo"],
      maxExternalCalls: 1,
    });

    expect(result.outcome.kind).toBe("ok");
    expect(firstResponse).toMatchObject({ ok: true });
    expect(secondResponse).toMatchObject({
      ok: false,
      error: expect.stringContaining("call cap exceeded"),
    });
    expect(result.externalCalls).toHaveLength(2);
    expect(result.externalCalls[0]?.ok).toBe(true);
    expect(result.externalCalls[1]?.ok).toBe(false);
  });

  it("returns timeout when wall_time_ms expires", async () => {
    const lifecycle = new Lifecycle();
    const host = new MontyHost({
      childFactory: fakeFactory({
        onStart: (emit) => emit({ type: "ready" }),
        // never react to start — the host's wall-timer should fire.
      }),
      registry: makeRegistry([]),
      lifecycle,
    });

    const result = await host.run({
      ...baseRunOpts,
      wallTimeMs: 50,
    });

    expect(result.outcome.kind).toBe("timeout");
    if (result.outcome.kind === "timeout") {
      expect(result.outcome.wallTimeMs).toBe(50);
    }
  });

  it("returns child_crashed when the child exits before result", async () => {
    const lifecycle = new Lifecycle();
    const host = new MontyHost({
      childFactory: fakeFactory({
        onStart: (emit) => emit({ type: "ready" }),
        react: (_frame, _emit, kill) => {
          // Simulate a Rust panic — the child dies without emitting a result.
          kill();
        },
      }),
      registry: makeRegistry([]),
      lifecycle,
    });

    const result = await host.run(baseRunOpts);

    expect(result.outcome.kind).toBe("child_crashed");
  });

  it("returns error when the child reports a script-level error", async () => {
    const lifecycle = new Lifecycle();
    const host = new MontyHost({
      childFactory: fakeFactory({
        onStart: (emit) => emit({ type: "ready" }),
        react: (frame, emit) => {
          if (frame.type === "start") {
            emit({
              type: "error",
              run_id: frame.run_id,
              error: "NameError: foo",
              traceback: "  File ...",
            });
          }
        },
      }),
      registry: makeRegistry([]),
      lifecycle,
    });

    const result = await host.run(baseRunOpts);

    expect(result.outcome.kind).toBe("error");
    if (result.outcome.kind === "error") {
      expect(result.outcome.error).toContain("NameError");
    }
  });

  it("returns cancelled when the upstream signal aborts", async () => {
    const lifecycle = new Lifecycle();
    const ac = new AbortController();
    const host = new MontyHost({
      childFactory: fakeFactory({
        onStart: (emit) => emit({ type: "ready" }),
        // Do not react — the abort should win.
      }),
      registry: makeRegistry([]),
      lifecycle,
    });

    const promise = host.run({ ...baseRunOpts, signal: ac.signal });
    setImmediate(() => ac.abort());
    const result = await promise;

    expect(result.outcome.kind).toBe("cancelled");
  });
});
