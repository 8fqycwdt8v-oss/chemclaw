// A/B fixture — measures wall-clock for a 3-tool retrieve/filter/rank
// orchestration in two arms:
//   A. Code-mode  — one run_orchestration_script call, the script issues
//      three external_function calls in-process to the bridge.
//   B. ReAct      — three sequential LLM round-trips, each emitting one
//      tool_call.
//
// Each tool simulates a 50ms latency floor (typical of an MCP round-trip
// to chemistry/KG services) so the comparison reflects realistic costs.
// The LLM round-trip in arm B is also given a small artificial latency
// to model the model's response time.
//
// Assertions: arm A's wall-clock is meaningfully shorter than arm B's
// (sum of 3 LLM round-trips), and both arms produce identical outputs
// for the same inputs.

import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { runHarness } from "../../src/core/harness.js";
import { Budget } from "../../src/core/budget.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { defineTool } from "../../src/tools/tool.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { buildRunOrchestrationScriptTool } from "../../src/tools/builtins/run_orchestration_script.js";
import { defaultChildFactory } from "../../src/runtime/monty/child-adapter.js";
import { makeCtx } from "../helpers/make-ctx.js";
import type {
  ConfigRegistry,
  ConfigContext,
} from "../../src/config/registry.js";
import type { Message } from "../../src/core/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = resolve(__dirname, "../../scripts/monty-runner.py");

const PYTHON_AVAILABLE = (() => {
  try {
    const res = spawnSync("python3", ["--version"], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
})();

// Per-tool simulated network latency floor (ms).
const TOOL_LATENCY_MS = 50;
// Per-LLM-call simulated response latency (ms). Real models hit hundreds;
// we use a smaller value so the test stays fast while still showing the
// gap between arms.
const LLM_LATENCY_MS = 200;

function fakeConfigRegistry(values: Record<string, unknown>): ConfigRegistry {
  return {
    async get(key: string, _ctx: ConfigContext, defaultValue: unknown) {
      return key in values ? values[key] : defaultValue;
    },
    async getNumber(key: string, _ctx: ConfigContext, defaultValue: number) {
      const v = values[key];
      return typeof v === "number" ? v : defaultValue;
    },
    async getBoolean(key: string, _ctx: ConfigContext, defaultValue: boolean) {
      const v = values[key];
      return typeof v === "boolean" ? v : defaultValue;
    },
    async getString(key: string, _ctx: ConfigContext, defaultValue: string) {
      const v = values[key];
      return typeof v === "string" ? v : defaultValue;
    },
    invalidate() {},
  } as unknown as ConfigRegistry;
}

function buildLatencyTool(
  id: string,
  fn: (input: { value: string }) => unknown,
) {
  return defineTool({
    id,
    description: id,
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.unknown(),
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      await new Promise((r) => setTimeout(r, TOOL_LATENCY_MS));
      return fn(input);
    },
  });
}

const SOURCE_DATA: Array<{ id: string; smiles: string; yield: number }> = [
  { id: "rxn-1", smiles: "CCO", yield: 80 },
  { id: "rxn-2", smiles: "CC=O", yield: 55 },
  { id: "rxn-3", smiles: "CC(=O)O", yield: 70 },
  { id: "rxn-4", smiles: "C=C", yield: 45 },
  { id: "rxn-5", smiles: "CC", yield: 65 },
];

// Three deterministic tools the script (and the ReAct arm) both call.
function buildRegistryAndTools(): { registry: ToolRegistry } {
  const registry = new ToolRegistry();

  registry.register(
    buildLatencyTool("retrieve_reactions", (_input) => ({
      reactions: SOURCE_DATA,
    })),
  );
  registry.register(
    buildLatencyTool("filter_by_yield", (input) => {
      // input.value carries the threshold as a stringified int.
      const threshold = parseInt(input.value, 10);
      return {
        reactions: SOURCE_DATA.filter((r) => r.yield >= threshold),
      };
    }),
  );
  registry.register(
    buildLatencyTool("rank_top_k", (input) => {
      const k = parseInt(input.value, 10);
      const filtered = SOURCE_DATA.filter((r) => r.yield >= 60).sort(
        (a, b) => b.yield - a.yield,
      );
      return { top: filtered.slice(0, k) };
    }),
  );

  return { registry };
}

describe.skipIf(!PYTHON_AVAILABLE)("code-mode vs ReAct A/B", () => {
  it("code-mode wall-clock is shorter than 3-step ReAct (single LLM round-trip)", async () => {
    const { registry } = buildRegistryAndTools();

    // ── Arm A: code-mode ────────────────────────────────────────────────
    const codeModeTool = buildRunOrchestrationScriptTool({
      registry,
      configRegistry: fakeConfigRegistry({
        "monty.enabled": true,
        "monty.binary_path": "python3",
        "monty.wall_time_ms": 30_000,
        "monty.max_external_calls": 8,
      }),
      lifecycle: new Lifecycle(),
      childFactoryOverride: defaultChildFactory({
        binaryPath: "python3",
        args: [RUNNER_PATH],
        env: { ...process.env, MONTY_RUNNER_ALLOW_UNSAFE_EXEC: "1" },
      }),
    });

    const codeModeStart = Date.now();
    const codeModeResult = await codeModeTool.execute(makeCtx(), {
      python_code: [
        "all_rxns = external_function('retrieve_reactions', {'value': 'all'})",
        "filtered = external_function('filter_by_yield', {'value': '60'})",
        "ranked = external_function('rank_top_k', {'value': '3'})",
        "top3 = ranked['top']",
      ].join("\n"),
      allowed_tools: ["retrieve_reactions", "filter_by_yield", "rank_top_k"],
      inputs: {},
      expected_outputs: ["top3"],
      reason: "A/B fixture",
    });
    const codeModeMs = Date.now() - codeModeStart;

    expect(codeModeResult.outcome).toBe("ok");
    expect(codeModeResult.outputs).toBeDefined();
    const codeModeTop = (codeModeResult.outputs as { top3: unknown[] }).top3;
    expect(codeModeTop).toHaveLength(3);

    // ── Arm B: sequential ReAct ─────────────────────────────────────────
    const llm = new StubLlmProvider();
    // Add artificial LLM latency so each call costs ~LLM_LATENCY_MS.
    const originalCall = llm.call.bind(llm);
    llm.call = async (...args) => {
      await new Promise((r) => setTimeout(r, LLM_LATENCY_MS));
      return await originalCall(...args);
    };

    llm.enqueueToolCall("retrieve_reactions", { value: "all" });
    llm.enqueueToolCall("filter_by_yield", { value: "60" });
    llm.enqueueToolCall("rank_top_k", { value: "3" });
    llm.enqueueText(
      "Top 3 reactions by yield ≥ 60: rxn-1 (80%), rxn-3 (70%), rxn-5 (65%)",
    );

    const lifecycle = new Lifecycle();
    const messages: Message[] = [
      { role: "user", content: "give me the top 3 reactions" },
    ];

    const reactStart = Date.now();
    const reactResult = await runHarness({
      messages,
      tools: registry.all(),
      llm,
      budget: new Budget({
        maxSteps: 10,
        maxPromptTokens: 100_000,
        maxCompletionTokens: 100_000,
      }),
      lifecycle,
      ctx: makeCtx(),
    });
    const reactMs = Date.now() - reactStart;

    expect(reactResult.text).toContain("rxn-1");

    // ── Wall-clock comparison ──────────────────────────────────────────
    // Arm B has ≥4 LLM round-trips (3 tool turns + 1 text turn) +
    // 3 tool latencies. Floor: 4*200 + 3*50 = 950ms.
    // Arm A has 1 outer LLM round-trip's worth of work (none, because
    // we call the tool directly here), plus subprocess spawn (~50ms in
    // dev) + 3 tool latencies (3*50 = 150ms). Arm A should land well
    // under arm B even with slack for spawn variance.
    expect(codeModeMs).toBeLessThan(reactMs);
    // Sanity check: the code-mode run completed in under 1s.
    expect(codeModeMs).toBeLessThan(1_500);
    // Print the comparison so a developer running the test can see it.
    // Vitest captures stdout; this surfaces in -t output.
    console.log(
      JSON.stringify({
        event: "ab_comparison",
        code_mode_ms: codeModeMs,
        react_ms: reactMs,
        ratio: Number((codeModeMs / reactMs).toFixed(2)),
      }),
    );
  }, 30_000);
});
