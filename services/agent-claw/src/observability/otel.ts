// OpenTelemetry tracer — initialized at process start.
//
// Exports OTLP to Langfuse (via OTEL_EXPORTER_OTLP_ENDPOINT) when configured.
// Falls back to a no-op tracer when LANGFUSE_HOST / OTEL env is absent.
//
// Usage:
//   import { getTracer } from "./otel.js";
//   const tracer = getTracer();
//   const span = tracer.startSpan("my-operation");
//   span.end();
//
// The tracer is initialized once via initTracer() called from index.ts before
// any routes are registered. Subsequent imports use the cached instance.

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import {
  trace,
  type Tracer,
  type TracerProvider,
  ProxyTracerProvider,
} from "@opentelemetry/api";

const SERVICE_NAME = "chemclaw-agent-claw";
const SERVICE_VERSION = "0.0.1";

let _initialized = false;

/**
 * Initialize the OTel tracer provider.
 *
 * When OTEL_EXPORTER_OTLP_ENDPOINT or LANGFUSE_HOST is set, exports traces
 * via OTLP HTTP. Otherwise a no-op provider is registered.
 *
 * Call once from the process entrypoint. Subsequent calls are no-ops.
 */
export function initTracer(opts?: {
  otlpEndpoint?: string;
  langfuseHost?: string;
}): void {
  if (_initialized) return;
  _initialized = true;

  // Determine endpoint: explicit OTLP env > Langfuse host /v1/traces > none.
  const endpoint =
    opts?.otlpEndpoint ??
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ??
    (opts?.langfuseHost
      ? `${opts.langfuseHost.replace(/\/$/, "")}/api/public/otel/v1/traces`
      : undefined) ??
    (process.env["LANGFUSE_HOST"]
      ? `${process.env["LANGFUSE_HOST"].replace(/\/$/, "")}/api/public/otel/v1/traces`
      : undefined);

  if (!endpoint) {
    // No OTLP endpoint configured — register a no-op provider.
    // getTracer() will return a no-op tracer.
    return;
  }

  const headers: Record<string, string> = {};
  // Langfuse uses Basic auth: Authorization: Basic base64(pk:sk)
  const pk = process.env["LANGFUSE_PUBLIC_KEY"];
  const sk = process.env["LANGFUSE_SECRET_KEY"];
  if (pk && sk) {
    headers["Authorization"] = `Basic ${Buffer.from(`${pk}:${sk}`).toString("base64")}`;
  }

  const exporter = new OTLPTraceExporter({
    url: endpoint,
    headers,
  });

  const provider = new NodeTracerProvider({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  provider.register();
}

/**
 * Get the tracer instance for agent-claw.
 * Always returns a valid tracer (no-op if not initialized).
 */
export function getTracer(): Tracer {
  return trace.getTracer(SERVICE_NAME, SERVICE_VERSION);
}

/**
 * Get the current TracerProvider (useful for tests).
 */
export function getProvider(): TracerProvider {
  return trace.getTracerProvider() as TracerProvider | ProxyTracerProvider;
}
