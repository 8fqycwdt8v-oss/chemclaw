// Telemetry tests — verify that the Monty bridge opens
// `monty.external_call` spans carrying parent_run_id / tool_id /
// duration / ok attributes, and that the runtime path is otherwise
// faithful to the OTel parent-child semantics.
//
// Uses an InMemorySpanExporter so we don't need a live OTLP collector.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import { defineTool } from "../../../../src/tools/tool.js";
import { Lifecycle } from "../../../../src/core/lifecycle.js";
import { routeExternalCall } from "../../../../src/runtime/monty/bridge.js";
import { makeCtx } from "../../../helpers/make-ctx.js";

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

beforeEach(() => {
  exporter.reset();
});

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

describe("monty bridge spans", () => {
  it("opens monty.external_call spans with parent_run_id + tool_id + duration attrs", async () => {
    const tool = buildEchoTool();
    const lifecycle = new Lifecycle();

    await routeExternalCall(
      { type: "external_call", id: 7, name: "echo", args: { value: "x" } },
      {
        registry: { get: () => tool },
        allowedToolIds: new Set(["echo"]),
        ctx: makeCtx(),
        lifecycle,
        parentRunId: "monty-run-abc",
      },
    );

    const spans = exporter.getFinishedSpans();
    const externalCallSpan = spans.find((s) => s.name === "monty.external_call");
    expect(externalCallSpan).toBeDefined();
    if (externalCallSpan) {
      expect(externalCallSpan.attributes).toMatchObject({
        "monty.external_call.tool_id": "echo",
        "monty.external_call.id": 7,
        "monty.external_call.ok": true,
        "monty.parent_run_id": "monty-run-abc",
      });
      expect(typeof externalCallSpan.attributes["monty.external_call.duration_ms"]).toBe(
        "number",
      );
    }

    // The inner tool.<id> span must be a child (parent span id matches).
    const toolSpan = spans.find((s) => s.name === "tool.echo");
    expect(toolSpan).toBeDefined();
    if (toolSpan && externalCallSpan) {
      expect(toolSpan.parentSpanId).toBe(externalCallSpan.spanContext().spanId);
    }
  });

  it("marks span ERROR when the inner tool denies / fails", async () => {
    const tool = buildEchoTool();
    const lifecycle = new Lifecycle();

    await routeExternalCall(
      { type: "external_call", id: 8, name: "blocked", args: {} },
      {
        registry: { get: () => undefined },
        allowedToolIds: new Set(["blocked"]),
        ctx: makeCtx(),
        lifecycle,
        parentRunId: "monty-run-xyz",
      },
    );

    const spans = exporter.getFinishedSpans();
    const externalCallSpan = spans.find((s) => s.name === "monty.external_call");
    expect(externalCallSpan).toBeDefined();
    if (externalCallSpan) {
      // 2 = ERROR in OTel SDK enum.
      expect(externalCallSpan.status.code).toBe(2);
      expect(externalCallSpan.attributes["monty.external_call.ok"]).toBe(false);
    }
    // No tool span should have opened — the bridge short-circuited before
    // runOneTool because the tool isn't registered.
    expect(spans.find((s) => s.name === "tool.blocked")).toBeUndefined();
    void tool; // keep unused var lint quiet
  });
});
