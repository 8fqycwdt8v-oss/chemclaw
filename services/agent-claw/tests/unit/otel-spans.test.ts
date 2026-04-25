// Vitest tests for observability/otel.ts and observability/spans.ts.
// The OTLP exporter is mocked — no network calls.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the OTel SDK so no real exports happen.
// ---------------------------------------------------------------------------

vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: vi.fn().mockImplementation(() => ({
    register: vi.fn(),
    getTracer: vi.fn(),
  })),
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  SimpleSpanProcessor: vi.fn(),
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: vi.fn(),
}));

vi.mock("@opentelemetry/resources", () => ({
  Resource: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
  ATTR_SERVICE_VERSION: "service.version",
}));

// ---------------------------------------------------------------------------
// Span attribute helpers
// ---------------------------------------------------------------------------

import { recordLlmUsage, recordSpanError } from "../../src/observability/spans.js";
import type { Span } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";

function makeSpySpan(): Span & { _attrs: Record<string, unknown>; _status: { code: number; message?: string } } {
  const span = {
    _attrs: {} as Record<string, unknown>,
    _status: { code: 0 },
    setAttribute(k: string, v: unknown) { this._attrs[k] = v; return this; },
    setStatus(s: { code: number; message?: string }) { this._status = s; return this; },
    end: vi.fn(),
    spanContext: vi.fn().mockReturnValue({
      traceId: "abc123",
      spanId: "def456",
      traceFlags: 1,
    }),
    isRecording: vi.fn().mockReturnValue(true),
    addEvent: vi.fn(),
    addLink: vi.fn(),
    recordException: vi.fn(),
    updateName: vi.fn(),
  } as unknown as Span & { _attrs: Record<string, unknown>; _status: { code: number; message?: string } };
  return span;
}

describe("recordLlmUsage", () => {
  it("sets token attributes on a span", () => {
    const span = makeSpySpan();
    recordLlmUsage(span, { promptTokens: 100, completionTokens: 50 });
    expect(span._attrs["llm.prompt_tokens"]).toBe(100);
    expect(span._attrs["llm.completion_tokens"]).toBe(50);
    expect(span._attrs["llm.total_tokens"]).toBe(150);
  });

  it("sets optional cost and latency attributes", () => {
    const span = makeSpySpan();
    recordLlmUsage(span, {
      promptTokens: 200,
      completionTokens: 80,
      estUsd: 0.003,
      model: "claude-haiku-4-5",
      latencyMs: 1200,
    });
    expect(span._attrs["llm.est_usd"]).toBe(0.003);
    expect(span._attrs["llm.model"]).toBe("claude-haiku-4-5");
    expect(span._attrs["llm.latency_ms"]).toBe(1200);
  });

  it("skips optional fields when not provided", () => {
    const span = makeSpySpan();
    recordLlmUsage(span, { promptTokens: 10, completionTokens: 5 });
    expect(span._attrs["llm.est_usd"]).toBeUndefined();
    expect(span._attrs["llm.latency_ms"]).toBeUndefined();
  });
});

describe("recordSpanError", () => {
  it("sets error status and message from Error instance", () => {
    const span = makeSpySpan();
    recordSpanError(span, new Error("something broke"));
    expect(span._status.code).toBe(SpanStatusCode.ERROR);
    expect(span._attrs["error.message"]).toBe("something broke");
  });

  it("sets error status and message from string", () => {
    const span = makeSpySpan();
    recordSpanError(span, "raw string error");
    expect(span._attrs["error.message"]).toBe("raw string error");
  });
});

describe("initTracer", () => {
  beforeEach(() => {
    // Reset the module so _initialized is reset between tests.
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("is callable without throwing when LANGFUSE_HOST is unset", async () => {
    const { initTracer } = await import("../../src/observability/otel.js");
    expect(() => initTracer({})).not.toThrow();
  });

  it("getTracer returns a tracer-like object", async () => {
    const { getTracer } = await import("../../src/observability/otel.js");
    const tracer = getTracer();
    expect(tracer).toBeDefined();
    expect(typeof tracer.startSpan).toBe("function");
  });
});
