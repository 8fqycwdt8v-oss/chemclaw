// Integration test — drive the full Monty pipeline through the actual
// Python runner script (spawned as a child process) using the unsafe-exec
// fallback so we don't need the Rust binary installed.
//
// Verifies:
//   * SubprocessChildAdapter spawns python3 + the runner
//   * The runner emits a ready frame, accepts a start frame, runs the script,
//     and returns the result
//   * external_function calls round-trip through the bridge to a real Tool
//   * Script-level exceptions surface as outcome="error"

import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { defineTool } from "../../src/tools/tool.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { MontyHost } from "../../src/runtime/monty/host.js";
import { defaultChildFactory } from "../../src/runtime/monty/child-adapter.js";
import { makeCtx } from "../helpers/make-ctx.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = resolve(
  __dirname,
  "../../scripts/monty-runner.py",
);

// Skip when python3 is missing — CI sandboxes without Python should not
// fail the suite. The pure-TS unit tests cover the bridge / host on their
// own; this test specifically exercises the cross-process boundary.
const PYTHON_AVAILABLE = (() => {
  try {
    const res = spawnSync("python3", ["--version"], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
})();

const ENV = {
  ...process.env,
  MONTY_RUNNER_ALLOW_UNSAFE_EXEC: "1",
};

function buildEchoTool() {
  return defineTool({
    id: "echo",
    description: "echo",
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ echoed: z.string() }),
    annotations: { readOnly: true },
    execute: async (_ctx, input) => ({ echoed: input.value.toUpperCase() }),
  });
}

function makeRegistry(tools: ReturnType<typeof buildEchoTool>[]): {
  get(id: string): ReturnType<typeof buildEchoTool> | undefined;
} {
  const map = new Map(tools.map((t) => [t.id, t]));
  return { get: (id) => map.get(id) };
}

const baseRunOpts = {
  runId: "monty-it",
  script: "",
  allowedTools: [] as string[],
  inputs: {},
  expectedOutputs: [] as string[],
  wallTimeMs: 10_000,
  maxExternalCalls: 8,
  ctx: makeCtx(),
};

describe.skipIf(!PYTHON_AVAILABLE)("monty-runner integration", () => {
  it("runs a pure-Python script end-to-end via the runner subprocess", async () => {
    const lifecycle = new Lifecycle();
    const host = new MontyHost({
      childFactory: defaultChildFactory({
        binaryPath: "python3",
        args: [RUNNER_PATH],
        env: ENV,
      }),
      registry: makeRegistry([]),
      lifecycle,
    });

    const result = await host.run({
      ...baseRunOpts,
      script: "answer = 6 * 7",
      expectedOutputs: ["answer"],
    });

    expect(result.outcome.kind).toBe("ok");
    if (result.outcome.kind === "ok") {
      expect(result.outcome.outputs).toEqual({ answer: 42 });
    }
  }, 15_000);

  it("dispatches external_function via the bridge and returns the parsed value", async () => {
    const lifecycle = new Lifecycle();
    const tool = buildEchoTool();
    const host = new MontyHost({
      childFactory: defaultChildFactory({
        binaryPath: "python3",
        args: [RUNNER_PATH],
        env: ENV,
      }),
      registry: makeRegistry([tool]),
      lifecycle,
    });

    const script = [
      "result = external_function('echo', {'value': 'hello'})",
    ].join("\n");

    const result = await host.run({
      ...baseRunOpts,
      script,
      allowedTools: ["echo"],
      expectedOutputs: ["result"],
    });

    expect(result.outcome.kind).toBe("ok");
    if (result.outcome.kind === "ok") {
      expect(result.outcome.outputs).toEqual({
        result: { echoed: "HELLO" },
      });
    }
    expect(result.externalCalls).toEqual([
      expect.objectContaining({ toolId: "echo", ok: true }),
    ]);
  }, 15_000);

  it("surfaces script-level exceptions as outcome=error with traceback", async () => {
    const lifecycle = new Lifecycle();
    const host = new MontyHost({
      childFactory: defaultChildFactory({
        binaryPath: "python3",
        args: [RUNNER_PATH],
        env: ENV,
      }),
      registry: makeRegistry([]),
      lifecycle,
    });

    const result = await host.run({
      ...baseRunOpts,
      script: "x = 1 / 0",
      expectedOutputs: ["x"],
    });

    expect(result.outcome.kind).toBe("error");
    if (result.outcome.kind === "error") {
      expect(result.outcome.error).toContain("ZeroDivisionError");
    }
  }, 15_000);

  it("script orchestrating multiple external_function calls (the headline use case)", async () => {
    const lifecycle = new Lifecycle();
    const tool = buildEchoTool();
    const host = new MontyHost({
      childFactory: defaultChildFactory({
        binaryPath: "python3",
        args: [RUNNER_PATH],
        env: ENV,
      }),
      registry: makeRegistry([tool]),
      lifecycle,
    });

    // Three calls + a pure-Python compose step. With sequential ReAct this
    // would be 3 separate LLM round-trips; in code-mode it's one call.
    const script = [
      "results = []",
      "for v in ['alpha', 'beta', 'gamma']:",
      "    out = external_function('echo', {'value': v})",
      "    results.append(out['echoed'])",
      "joined = ' / '.join(results)",
    ].join("\n");

    const result = await host.run({
      ...baseRunOpts,
      script,
      allowedTools: ["echo"],
      expectedOutputs: ["joined"],
    });

    expect(result.outcome.kind).toBe("ok");
    if (result.outcome.kind === "ok") {
      expect(result.outcome.outputs).toEqual({
        joined: "ALPHA / BETA / GAMMA",
      });
    }
    expect(result.externalCalls).toHaveLength(3);
    for (const call of result.externalCalls) {
      expect(call.ok).toBe(true);
    }
  }, 20_000);

  it("denies external_function calls outside the allow-list", async () => {
    const lifecycle = new Lifecycle();
    const tool = buildEchoTool();
    const host = new MontyHost({
      childFactory: defaultChildFactory({
        binaryPath: "python3",
        args: [RUNNER_PATH],
        env: ENV,
      }),
      registry: makeRegistry([tool]),
      lifecycle,
    });

    const script = [
      "try:",
      "    external_function('forbidden', {})",
      "    denied = False",
      "except RuntimeError as e:",
      "    denied = True",
      "    msg = str(e)",
    ].join("\n");

    const result = await host.run({
      ...baseRunOpts,
      script,
      allowedTools: ["echo"],
      expectedOutputs: ["denied", "msg"],
    });

    expect(result.outcome.kind).toBe("ok");
    if (result.outcome.kind === "ok") {
      expect(result.outcome.outputs.denied).toBe(true);
      expect(String(result.outcome.outputs.msg)).toContain(
        "not in allowed_tools",
      );
    }
  }, 15_000);
});
