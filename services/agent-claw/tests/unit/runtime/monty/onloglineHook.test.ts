// Tests that MontyHost.run forwards stdout/stderr lines to the
// onLogLine callback as they arrive, in addition to buffering them
// for the final result.

import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Lifecycle } from "../../../../src/core/lifecycle.js";
import { ToolRegistry } from "../../../../src/tools/registry.js";
import { MontyHost } from "../../../../src/runtime/monty/host.js";
import type {
  ChildToHostFrameT,
  HostToChildFrameT,
} from "../../../../src/runtime/monty/protocol.js";
import type {
  MontyChild,
  MontyChildEvents,
} from "../../../../src/runtime/monty/child-adapter.js";
import { makeCtx } from "../../../helpers/make-ctx.js";

class ScriptedChild extends EventEmitter implements MontyChild {
  private _alive = true;
  constructor(
    private readonly script: (
      emit: (frame: ChildToHostFrameT) => void,
      emitStderr: (line: string) => void,
    ) => Promise<void>,
  ) {
    super();
    setImmediate(() => {
      void this.script(
        (frame) => {
          if (this._alive) this.emit("frame", frame);
        },
        (line) => {
          if (this._alive) this.emit("stderr_line", line);
        },
      );
    });
  }
  send(_frame: HostToChildFrameT): void {
    // ignore; the test script drives behavior directly
  }
  kill(): void {
    if (!this._alive) return;
    this._alive = false;
    setImmediate(() => this.emit("exit", 0, null));
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

describe("MontyHost.run — onLogLine callback", () => {
  it("invokes onLogLine for each log frame and stderr_line as they arrive", async () => {
    const lines: Array<{ stream: "stdout" | "stderr"; line: string }> = [];

    const host = new MontyHost({
      childFactory: () =>
        new ScriptedChild(async (emit, emitStderr) => {
          emit({ type: "ready" });
          await new Promise((r) => setImmediate(r));
          emit({ type: "log", stream: "stdout", message: "first" });
          emit({ type: "log", stream: "stdout", message: "second" });
          emitStderr("warn-line");
          emit({ type: "result", run_id: "r1", outputs: { x: 1 } });
        }),
      registry: new ToolRegistry(),
      lifecycle: new Lifecycle(),
    });

    const result = await host.run({
      runId: "r1",
      script: "x = 1",
      allowedTools: [],
      inputs: {},
      expectedOutputs: ["x"],
      wallTimeMs: 5_000,
      maxExternalCalls: 0,
      ctx: makeCtx(),
      onLogLine: (stream, line) => {
        lines.push({ stream, line });
      },
    });

    expect(result.outcome.kind).toBe("ok");
    // All three lines should have streamed.
    expect(lines).toEqual([
      { stream: "stdout", line: "first" },
      { stream: "stdout", line: "second" },
      { stream: "stderr", line: "warn-line" },
    ]);
    // The final buffered result still includes the same content.
    expect(result.stdout).toContain("first");
    expect(result.stdout).toContain("second");
    expect(result.stderr).toContain("warn-line");
  });

  it("a throwing onLogLine does not crash the run", async () => {
    const host = new MontyHost({
      childFactory: () =>
        new ScriptedChild(async (emit) => {
          emit({ type: "ready" });
          await new Promise((r) => setImmediate(r));
          emit({ type: "log", stream: "stdout", message: "anything" });
          emit({ type: "result", run_id: "r1", outputs: { x: 1 } });
        }),
      registry: new ToolRegistry(),
      lifecycle: new Lifecycle(),
    });

    const result = await host.run({
      runId: "r1",
      script: "x = 1",
      allowedTools: [],
      inputs: {},
      expectedOutputs: ["x"],
      wallTimeMs: 5_000,
      maxExternalCalls: 0,
      ctx: makeCtx(),
      onLogLine: () => {
        throw new Error("sink boom");
      },
    });
    // Run should still succeed; the throw is logged + dropped.
    expect(result.outcome.kind).toBe("ok");
    expect(result.stdout).toContain("anything");
  });
});
