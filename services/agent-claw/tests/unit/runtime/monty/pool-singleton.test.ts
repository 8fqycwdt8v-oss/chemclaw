// Tests for the Monty WarmChildPool singleton wiring (pool-singleton.ts +
// run_orchestration_script's getPool path). Verifies:
//   - the singleton returns undefined when monty.enabled is false (no
//     pool spawned in disabled tenants)
//   - the singleton caches the pool promise across calls
//   - run_orchestration_script's getPool path falls back to spawn-per-run
//     when getPool resolves undefined
//   - run_orchestration_script's getPool path uses the pool's children
//     when one is provided

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EventEmitter } from "node:events";
import { defineTool } from "../../../../src/tools/tool.js";
import { Lifecycle } from "../../../../src/core/lifecycle.js";
import { ToolRegistry } from "../../../../src/tools/registry.js";
import { buildRunOrchestrationScriptTool } from "../../../../src/tools/builtins/run_orchestration_script.js";
import { WarmChildPool } from "../../../../src/runtime/monty/pool.js";
import {
  _resetMontyPoolForTests,
  getOrCreateMontyPool,
} from "../../../../src/runtime/monty/pool-singleton.js";
import type { ConfigRegistry } from "../../../../src/config/registry.js";
import type {
  ChildToHostFrameT,
  HostToChildFrameT,
} from "../../../../src/runtime/monty/protocol.js";
import type {
  MontyChild,
  MontyChildEvents,
  MontyChildFactory,
} from "../../../../src/runtime/monty/child-adapter.js";
import { makeCtx } from "../../../helpers/make-ctx.js";

afterEach(() => {
  _resetMontyPoolForTests();
});

class FakeChild extends EventEmitter implements MontyChild {
  private _alive = true;
  constructor(
    private readonly onStart?: (emit: (frame: ChildToHostFrameT) => void) => void,
    private readonly react?: (
      frame: HostToChildFrameT,
      emit: (frame: ChildToHostFrameT) => void,
    ) => void,
  ) {
    super();
    setImmediate(() => this.onStart?.(this._emit));
  }
  private _emit = (frame: ChildToHostFrameT): void => {
    if (this._alive) this.emit("frame", frame);
  };
  send(frame: HostToChildFrameT): void {
    if (!this._alive) return;
    setImmediate(() => this.react?.(frame, this._emit));
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

function fakeRegistry(values: Record<string, unknown>): ConfigRegistry {
  return {
    async get(key: string, _ctx: unknown, defaultValue: unknown) {
      return key in values ? values[key] : defaultValue;
    },
    async getNumber(key: string, _ctx: unknown, defaultValue: number) {
      const v = values[key];
      return typeof v === "number" ? v : defaultValue;
    },
    async getBoolean(key: string, _ctx: unknown, defaultValue: boolean) {
      const v = values[key];
      return typeof v === "boolean" ? v : defaultValue;
    },
    async getString(key: string, _ctx: unknown, defaultValue: string) {
      const v = values[key];
      return typeof v === "string" ? v : defaultValue;
    },
    invalidate() {},
  } as unknown as ConfigRegistry;
}

describe("pool-singleton: getOrCreateMontyPool", () => {
  it("returns undefined when monty.enabled is false (default)", async () => {
    const pool = await getOrCreateMontyPool(fakeRegistry({}));
    expect(pool).toBeUndefined();
  });

  it("returns undefined when monty.binary_path is empty", async () => {
    const pool = await getOrCreateMontyPool(
      fakeRegistry({ "monty.enabled": true, "monty.binary_path": "" }),
    );
    expect(pool).toBeUndefined();
  });

  it("returns undefined when monty.warm_pool_size is 0", async () => {
    const pool = await getOrCreateMontyPool(
      fakeRegistry({
        "monty.enabled": true,
        "monty.binary_path": "/fake/monty",
        "monty.warm_pool_size": 0,
      }),
    );
    expect(pool).toBeUndefined();
  });

  it("caches the pool promise across calls", async () => {
    const reg = fakeRegistry({});
    const spy = vi.spyOn(reg, "getBoolean");
    const a = await getOrCreateMontyPool(reg);
    const b = await getOrCreateMontyPool(reg);
    expect(a).toBe(b);
    // Singleton should resolve limits once on first call only.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("run_orchestration_script: getPool wiring", () => {
  function fakeChildFactory(): MontyChildFactory {
    return () =>
      new FakeChild(
        (emit) => emit({ type: "ready" }),
        (frame, emit) => {
          if (frame.type === "start") {
            emit({ type: "result", run_id: "r1", outputs: { x: 1 } });
          }
        },
      );
  }

  it("falls back to spawn-per-run when getPool resolves undefined", async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        id: "echo",
        description: "echo",
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
        annotations: { readOnly: true },
        execute: async (_ctx, input) => ({ echoed: input.value }),
      }),
    );
    const tool = buildRunOrchestrationScriptTool({
      registry,
      configRegistry: fakeRegistry({
        "monty.enabled": true,
        "monty.binary_path": "/fake/monty",
        "monty.wall_time_ms": 5_000,
        "monty.max_external_calls": 8,
        "monty.warm_pool_size": 0,
      }),
      lifecycle: new Lifecycle(),
      childFactoryOverride: fakeChildFactory(),
      getPool: async () => undefined,
    });
    const out = await tool.execute(makeCtx(), {
      python_code: "x = 1",
      allowed_tools: ["echo"],
      inputs: {},
      expected_outputs: ["x"],
      reason: "test",
    });
    expect(out.outcome).toBe("ok");
  });

  it("uses the pool's acquire when getPool resolves a pool", async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        id: "echo",
        description: "echo",
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
        annotations: { readOnly: true },
        execute: async (_ctx, input) => ({ echoed: input.value }),
      }),
    );

    let acquireCount = 0;
    const fakePool = {
      acquire: async () => {
        acquireCount += 1;
        return new FakeChild(
          (emit) => emit({ type: "ready" }),
          (frame, emit) => {
            if (frame.type === "start") {
              emit({ type: "result", run_id: "r1", outputs: { x: 1 } });
            }
          },
        );
      },
    } as unknown as WarmChildPool;

    const tool = buildRunOrchestrationScriptTool({
      registry,
      configRegistry: fakeRegistry({
        "monty.enabled": true,
        "monty.binary_path": "/fake/monty",
        "monty.wall_time_ms": 5_000,
        "monty.max_external_calls": 8,
        "monty.warm_pool_size": 0,
      }),
      lifecycle: new Lifecycle(),
      // childFactoryOverride deliberately omitted so the getPool path is taken.
      getPool: async () => fakePool,
    });
    const out = await tool.execute(makeCtx(), {
      python_code: "x = 1",
      allowed_tools: ["echo"],
      inputs: {},
      expected_outputs: ["x"],
      reason: "test",
    });
    expect(out.outcome).toBe("ok");
    expect(acquireCount).toBe(1);
  });
});
