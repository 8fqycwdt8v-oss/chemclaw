// Tests for run_orchestration_script — exercises the builtin end-to-end with
// a fake child adapter so the Monty binary is not required. Verifies the
// preflight gates, the runtime-disabled fallback, and that allow-listed
// inner tools dispatch via runOneTool.

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { EventEmitter } from "node:events";
import { defineTool } from "../../../src/tools/tool.js";
import { Lifecycle } from "../../../src/core/lifecycle.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import { buildRunOrchestrationScriptTool } from "../../../src/tools/builtins/run_orchestration_script.js";
import type { PermissionOptions } from "../../../src/core/types.js";
import type {
  ChildToHostFrameT,
  HostToChildFrameT,
} from "../../../src/runtime/monty/protocol.js";
import type {
  MontyChild,
  MontyChildEvents,
  MontyChildFactory,
} from "../../../src/runtime/monty/child-adapter.js";
import type { ConfigRegistry } from "../../../src/config/registry.js";
import { makeCtx } from "../../helpers/make-ctx.js";

interface FakeChildBehavior {
  onStart?: (emit: (frame: ChildToHostFrameT) => void) => void;
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
    setImmediate(() => this.behavior.onStart?.(this._emit));
  }
  private _emit = (frame: ChildToHostFrameT): void => {
    if (this._alive) this.emit("frame", frame);
  };
  send(frame: HostToChildFrameT): void {
    if (!this._alive) return;
    setImmediate(() => this.behavior.react?.(frame, this._emit, () => this.kill()));
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

function fakeFactory(behavior: FakeChildBehavior): MontyChildFactory {
  return () => new FakeChild(behavior);
}

function fakeConfigRegistry(values: Record<string, unknown>): ConfigRegistry {
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

const ENABLED_CONFIG = {
  "monty.enabled": true,
  "monty.binary_path": "/fake/monty",
  "monty.wall_time_ms": 5_000,
  "monty.max_external_calls": 8,
  "monty.warm_pool_size": 0,
};

function buildRegistryWithEcho(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      id: "echo",
      description: "echo",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
      annotations: { readOnly: true },
      execute: async (_ctx, input) => ({ echoed: input.value.toUpperCase() }),
    }),
  );
  return registry;
}

describe("run_orchestration_script", () => {
  it("returns runtime_disabled when monty.enabled is false", async () => {
    const tool = buildRunOrchestrationScriptTool({
      registry: buildRegistryWithEcho(),
      configRegistry: fakeConfigRegistry({}),
      lifecycle: new Lifecycle(),
      childFactoryOverride: fakeFactory({}),
    });
    const out = await tool.execute(makeCtx(), {
      python_code: "x = 1",
      allowed_tools: ["echo"],
      inputs: {},
      expected_outputs: ["x"],
      reason: "test",
    });
    expect(out.outcome).toBe("runtime_disabled");
    expect(out.error).toContain("disabled");
  });

  it("returns runtime_disabled when binary_path is unset", async () => {
    const tool = buildRunOrchestrationScriptTool({
      registry: buildRegistryWithEcho(),
      configRegistry: fakeConfigRegistry({ "monty.enabled": true }),
      lifecycle: new Lifecycle(),
      childFactoryOverride: fakeFactory({}),
    });
    const out = await tool.execute(makeCtx(), {
      python_code: "x = 1",
      allowed_tools: ["echo"],
      inputs: {},
      expected_outputs: ["x"],
      reason: "test",
    });
    expect(out.outcome).toBe("runtime_disabled");
    expect(out.error).toContain("binary_path");
  });

  it("preflight-denies forbidden interactive / mutating tools", async () => {
    const tool = buildRunOrchestrationScriptTool({
      registry: buildRegistryWithEcho(),
      configRegistry: fakeConfigRegistry(ENABLED_CONFIG),
      lifecycle: new Lifecycle(),
      childFactoryOverride: fakeFactory({}),
    });
    const out = await tool.execute(makeCtx(), {
      python_code: "x = 1",
      allowed_tools: ["echo", "ask_user"],
      inputs: {},
      expected_outputs: ["x"],
      reason: "test",
    });
    expect(out.outcome).toBe("preflight_denied");
    expect(out.error).toContain("ask_user");
  });

  it("preflight-denies unknown tools", async () => {
    const tool = buildRunOrchestrationScriptTool({
      registry: buildRegistryWithEcho(),
      configRegistry: fakeConfigRegistry(ENABLED_CONFIG),
      lifecycle: new Lifecycle(),
      childFactoryOverride: fakeFactory({}),
    });
    const out = await tool.execute(makeCtx(), {
      python_code: "x = 1",
      allowed_tools: ["echo", "no_such_tool"],
      inputs: {},
      expected_outputs: ["x"],
      reason: "test",
    });
    expect(out.outcome).toBe("preflight_denied");
    expect(out.error).toContain("no_such_tool");
  });

  it("happy path: runs script, dispatches one external call, returns ok", async () => {
    const tool = buildRunOrchestrationScriptTool({
      registry: buildRegistryWithEcho(),
      configRegistry: fakeConfigRegistry(ENABLED_CONFIG),
      lifecycle: new Lifecycle(),
      childFactoryOverride: fakeFactory({
        onStart: (emit) => emit({ type: "ready" }),
        react: (frame, emit) => {
          if (frame.type === "start") {
            emit({
              type: "external_call",
              id: 1,
              name: "echo",
              args: { value: "hi" },
            });
          } else if (frame.type === "external_response") {
            emit({
              type: "result",
              run_id: "r1",
              outputs: { result: frame.value },
            });
          }
        },
      }),
    });
    const out = await tool.execute(makeCtx(), {
      python_code: "noop",
      allowed_tools: ["echo"],
      inputs: {},
      expected_outputs: ["result"],
      reason: "compose",
    });
    expect(out.outcome).toBe("ok");
    expect(out.outputs).toEqual({ result: { echoed: "HI" } });
    expect(out.external_calls).toEqual([
      expect.objectContaining({ tool_id: "echo", ok: true }),
    ]);
  });

  it("script error surfaces as outcome=error with the message preserved", async () => {
    const tool = buildRunOrchestrationScriptTool({
      registry: buildRegistryWithEcho(),
      configRegistry: fakeConfigRegistry(ENABLED_CONFIG),
      lifecycle: new Lifecycle(),
      childFactoryOverride: fakeFactory({
        onStart: (emit) => emit({ type: "ready" }),
        react: (frame, emit) => {
          if (frame.type === "start") {
            emit({
              type: "error",
              run_id: frame.run_id,
              error: "ZeroDivisionError",
            });
          }
        },
      }),
    });
    const out = await tool.execute(makeCtx(), {
      python_code: "1/0",
      allowed_tools: ["echo"],
      inputs: {},
      expected_outputs: ["x"],
      reason: "test",
    });
    expect(out.outcome).toBe("error");
    expect(out.error).toContain("ZeroDivisionError");
  });

  it("rejects calls to tools outside allowed_tools at the bridge layer", async () => {
    const registry = buildRegistryWithEcho();
    registry.register(
      defineTool({
        id: "secret",
        description: "secret",
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        annotations: { readOnly: true },
        execute: async () => ({ ok: true }),
      }),
    );

    let secretResp: unknown;
    const tool = buildRunOrchestrationScriptTool({
      registry,
      configRegistry: fakeConfigRegistry(ENABLED_CONFIG),
      lifecycle: new Lifecycle(),
      childFactoryOverride: fakeFactory({
        onStart: (emit) => emit({ type: "ready" }),
        react: (frame, emit) => {
          if (frame.type === "start") {
            emit({
              type: "external_call",
              id: 1,
              name: "secret",
              args: {},
            });
          } else if (frame.type === "external_response") {
            secretResp = frame;
            emit({ type: "result", run_id: "r1", outputs: { x: 0 } });
          }
        },
      }),
    });

    await tool.execute(makeCtx(), {
      python_code: "noop",
      allowed_tools: ["echo"],
      inputs: {},
      expected_outputs: ["x"],
      reason: "test",
    });

    expect(secretResp).toMatchObject({
      ok: false,
      error: expect.stringContaining("not in allowed_tools"),
    });
  });

  it("preflight-denies allow-listed tools the outer permissions reject (ctx.permissions)", async () => {
    const tool = buildRunOrchestrationScriptTool({
      registry: buildRegistryWithEcho(),
      configRegistry: fakeConfigRegistry(ENABLED_CONFIG),
      lifecycle: new Lifecycle(),
      childFactoryOverride: fakeFactory({}),
    });
    // dontAsk + empty allowedTools → resolver denies any tool not on
    // the (empty) list. Builtin sees ctx.permissions and short-circuits.
    const ctx = makeCtx();
    ctx.permissions = {
      permissionMode: "dontAsk",
      allowedTools: [],
    } satisfies PermissionOptions;

    const out = await tool.execute(ctx, {
      python_code: "noop",
      allowed_tools: ["echo"],
      inputs: {},
      expected_outputs: ["x"],
      reason: "test",
    });

    expect(out.outcome).toBe("preflight_denied");
    expect(out.error).toMatch(/denied_by_permissions/);
  });

  it("threads ctx.permissions into the bridge so inner calls re-resolve", async () => {
    const tool = buildRunOrchestrationScriptTool({
      registry: buildRegistryWithEcho(),
      configRegistry: fakeConfigRegistry(ENABLED_CONFIG),
      lifecycle: new Lifecycle(),
      childFactoryOverride: fakeFactory({
        onStart: (emit) => emit({ type: "ready" }),
        react: (frame, emit) => {
          if (frame.type === "start") {
            emit({
              type: "external_call",
              id: 1,
              name: "echo",
              args: { value: "x" },
            });
          } else if (frame.type === "external_response") {
            emit({
              type: "result",
              run_id: "r1",
              outputs: { ok: frame.ok },
            });
          }
        },
      }),
    });
    // bypassPermissions through ctx — inner call should succeed.
    const ctx = makeCtx();
    ctx.permissions = {
      permissionMode: "bypassPermissions",
    } satisfies PermissionOptions;

    const out = await tool.execute(ctx, {
      python_code: "noop",
      allowed_tools: ["echo"],
      inputs: {},
      expected_outputs: ["ok"],
      reason: "test",
    });

    expect(out.outcome).toBe("ok");
    expect(out.outputs).toEqual({ ok: true });
  });
});
