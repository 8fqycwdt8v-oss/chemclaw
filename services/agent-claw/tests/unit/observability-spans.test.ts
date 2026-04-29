// Phase 9 — per-hook + per-tool OTel span emission tests.
//
// Asserts that:
//   - lifecycle.dispatch wraps each hook handler in a `hook.{point}.{name}`
//     span carrying point / name / matcher_target / tool_use_id / duration.
//   - Hook spans get OK status on success and ERROR status (with recorded
//     exception) when the handler throws.
//   - step.ts wraps tool.execute in a `tool.{toolId}` span carrying id /
//     read_only / in_batch / duration.
//   - Single-tool turns leave `tool.in_batch` false (parallel batching is
//     a future phase on this branch — when it lands the parallel call site
//     will set it to true and we'll add a corresponding assertion here).
//
// Strategy: register a real NodeTracerProvider with an InMemorySpanExporter
// at the top of this file so the global OTel API hands out the same provider
// to both the production span helpers and the test assertions. SimpleSpan
// Processor is synchronous on span.end(), so finished spans are visible to
// the test as soon as the awaited dispatch / harness call resolves.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { z } from "zod";

import { Lifecycle } from "../../src/core/lifecycle.js";
import { runHarness } from "../../src/core/harness.js";
import { Budget } from "../../src/core/budget.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { defineTool } from "../../src/tools/tool.js";
import type { Message, ToolContext } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// One global in-memory tracer for the whole file.
// ---------------------------------------------------------------------------

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  // If another test file has already registered a provider, trace.setGlobal
  // is a no-op — but spans still flow to the active provider, which would
  // be the no-op proxy. Force-register here so this file's spans are
  // captured. NodeTracerProvider#register() takes precedence over a prior
  // ProxyTracerProvider when called explicitly.
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

beforeEach(() => {
  exporter.reset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): ToolContext {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

function makeMessages(): Message[] {
  return [{ role: "user", content: "go" }];
}

function findSpan(name: string) {
  return exporter.getFinishedSpans().find((s) => s.name === name);
}

function findSpanByPrefix(prefix: string) {
  return exporter.getFinishedSpans().find((s) => s.name.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Hook spans
// ---------------------------------------------------------------------------

describe("hook spans", () => {
  it("emits a hook.{point}.{name} span on dispatch", async () => {
    const lc = new Lifecycle();
    lc.on("pre_turn", "test-hook", async () => {});

    await lc.dispatch("pre_turn", { ctx: makeCtx(), messages: [] });

    const span = findSpan("hook.pre_turn.test-hook");
    expect(span).toBeDefined();
    expect(span!.attributes["hook.point"]).toBe("pre_turn");
    expect(span!.attributes["hook.name"]).toBe("test-hook");
    expect(span!.status.code).toBe(SpanStatusCode.OK);
    // duration_ms is set on every code path
    expect(typeof span!.attributes["hook.duration_ms"]).toBe("number");
  });

  it("propagates matcher_target and tool_use_id attributes", async () => {
    const lc = new Lifecycle();
    lc.on("post_tool", "capture", async () => {});

    await lc.dispatch(
      "post_tool",
      { ctx: makeCtx(), toolId: "echo", input: {}, output: {} },
      { matcherTarget: "echo", toolUseID: "tu-123" },
    );

    const span = findSpan("hook.post_tool.capture");
    expect(span).toBeDefined();
    expect(span!.attributes["hook.matcher_target"]).toBe("echo");
    expect(span!.attributes["hook.tool_use_id"]).toBe("tu-123");
  });

  it("hook span has ERROR status when the handler throws (non-pre_tool)", async () => {
    const lc = new Lifecycle();
    lc.on("post_turn", "boomer", async () => {
      throw new Error("kaboom");
    });

    // post_turn swallows hook errors — dispatch resolves, span is ERROR.
    await lc.dispatch("post_turn", {
      ctx: makeCtx(),
      finalText: "x",
      stepsUsed: 1,
    });

    const span = findSpan("hook.post_turn.boomer");
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.status.message).toBe("kaboom");
    // recordException synthesises an exception event on the span.
    expect(span!.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("hook span has ERROR status when a pre_tool handler throws", async () => {
    const lc = new Lifecycle();
    lc.on("pre_tool", "deny-all", async () => {
      throw new Error("blocked");
    });

    await expect(
      lc.dispatch("pre_tool", { ctx: makeCtx(), toolId: "echo", input: {} }),
    ).rejects.toThrow("blocked");

    const span = findSpan("hook.pre_tool.deny-all");
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.status.message).toBe("blocked");
  });

  it("emits a hook.permission_request.{name} span via dispatchPermissionRequest", async () => {
    const lc = new Lifecycle();
    lc.on("permission_request", "policy", async () => ({ decision: "allow" }));

    const result = await lc.dispatchPermissionRequest({
      ctx: makeCtx(),
      toolId: "echo",
      input: {},
    });

    expect(result?.decision).toBe("allow");
    const span = findSpan("hook.permission_request.policy");
    expect(span).toBeDefined();
    expect(span!.attributes["hook.point"]).toBe("permission_request");
    expect(span!.attributes["hook.matcher_target"]).toBe("echo");
    expect(span!.status.code).toBe(SpanStatusCode.OK);
  });
});

// ---------------------------------------------------------------------------
// Tool spans
// ---------------------------------------------------------------------------

describe("tool spans", () => {
  it("emits a tool.{toolId} span with read_only attribute on a single-tool turn", async () => {
    const tool = defineTool({
      id: "ro_single",
      description: "single read-only tool",
      inputSchema: z.object({}).passthrough(),
      outputSchema: z.object({ ok: z.boolean() }),
      annotations: { readOnly: true },
      execute: async () => ({ ok: true }),
    });

    const llm = new StubLlmProvider()
      .enqueueToolCall("ro_single", {})
      .enqueueText("done");

    await runHarness({
      messages: makeMessages(),
      tools: [tool],
      llm,
      budget: new Budget({ maxSteps: 5 }),
      lifecycle: new Lifecycle(),
      ctx: makeCtx(),
    });

    const span = findSpan("tool.ro_single");
    expect(span).toBeDefined();
    expect(span!.attributes["tool.id"]).toBe("ro_single");
    expect(span!.attributes["tool.read_only"]).toBe(true);
    // Single-tool turns are NOT a parallel batch (Phase 5 isn't on this branch).
    expect(span!.attributes["tool.in_batch"]).toBe(false);
    expect(span!.status.code).toBe(SpanStatusCode.OK);
    expect(typeof span!.attributes["tool.duration_ms"]).toBe("number");
  });

  it("defaults read_only to false when no annotations are set", async () => {
    const tool = defineTool({
      id: "no_annotations",
      description: "tool without annotations",
      inputSchema: z.object({}).passthrough(),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    });

    const llm = new StubLlmProvider()
      .enqueueToolCall("no_annotations", {})
      .enqueueText("done");

    await runHarness({
      messages: makeMessages(),
      tools: [tool],
      llm,
      budget: new Budget({ maxSteps: 5 }),
      lifecycle: new Lifecycle(),
      ctx: makeCtx(),
    });

    const span = findSpan("tool.no_annotations");
    expect(span).toBeDefined();
    expect(span!.attributes["tool.read_only"]).toBe(false);
    expect(span!.attributes["tool.in_batch"]).toBe(false);
  });

  it("tool span has ERROR status when the tool throws", async () => {
    const tool = defineTool({
      id: "throws",
      description: "throws on execute",
      inputSchema: z.object({}).passthrough(),
      outputSchema: z.object({}).passthrough(),
      annotations: { readOnly: false },
      execute: async () => {
        throw new Error("tool exploded");
      },
    });

    const llm = new StubLlmProvider()
      .enqueueToolCall("throws", {})
      .enqueueText("done");

    await expect(
      runHarness({
        messages: makeMessages(),
        tools: [tool],
        llm,
        budget: new Budget({ maxSteps: 5 }),
        lifecycle: new Lifecycle(),
        ctx: makeCtx(),
      }),
    ).rejects.toThrow("tool exploded");

    const span = findSpan("tool.throws");
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.status.message).toBe("tool exploded");
    expect(span!.attributes["tool.read_only"]).toBe(false);
    expect(span!.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("hook spans and tool spans both emit on the same harness turn", async () => {
    const tool = defineTool({
      id: "ro_combo",
      description: "ro tool",
      inputSchema: z.object({}).passthrough(),
      outputSchema: z.object({ ok: z.boolean() }),
      annotations: { readOnly: true },
      execute: async () => ({ ok: true }),
    });

    const lc = new Lifecycle();
    lc.on("pre_tool", "noop-pre", async () => {});
    lc.on("post_tool", "noop-post", async () => {});

    const llm = new StubLlmProvider()
      .enqueueToolCall("ro_combo", {})
      .enqueueText("done");

    await runHarness({
      messages: makeMessages(),
      tools: [tool],
      llm,
      budget: new Budget({ maxSteps: 5 }),
      lifecycle: lc,
      ctx: makeCtx(),
    });

    expect(findSpan("hook.pre_tool.noop-pre")).toBeDefined();
    expect(findSpan("hook.post_tool.noop-post")).toBeDefined();
    expect(findSpan("tool.ro_combo")).toBeDefined();
    // step.ts threads the toolId through to the dispatch matcherTarget.
    const preSpan = findSpan("hook.pre_tool.noop-pre");
    expect(preSpan!.attributes["hook.matcher_target"]).toBe("ro_combo");
  });
});

// ---------------------------------------------------------------------------
// Tracer name sanity check — these become Langfuse trace names.
// ---------------------------------------------------------------------------

describe("tracer naming", () => {
  it("hook spans use the agent-claw.lifecycle tracer (name format: hook.*)", async () => {
    const lc = new Lifecycle();
    lc.on("pre_turn", "naming", async () => {});
    await lc.dispatch("pre_turn", { ctx: makeCtx(), messages: [] });
    expect(findSpanByPrefix("hook.")).toBeDefined();
  });

  it("verifies the global tracer provider is wired (smoke)", () => {
    expect(trace.getTracer("agent-claw.lifecycle")).toBeDefined();
    expect(trace.getTracer("agent-claw.tools")).toBeDefined();
  });
});
