// Per-tool OTel span helper.
//
// Phase 9: every Tool.execute call from step.ts wraps its execution in
// withToolSpan so Langfuse / OTLP receives a span per tool invocation with
// id, read-only annotation, in-batch flag, duration, and OK/ERROR status.
//
// When the OTel tracer provider is the default (no-op) one, startActiveSpan
// returns a no-op span and the wrapper still forwards the handler result —
// callers see no behavioural change. The OTLP exporter is wired in
// observability/otel.ts; this file only emits.

import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("agent-claw.tools");

export interface ToolSpanAttributes {
  /** Tool identifier (Tool.id). */
  toolId: string;
  /** True if the tool is annotated `readOnly: true` on its registry entry. */
  readOnly?: boolean;
  /** True when the call is part of a parallel read-only batch (Phase 5). */
  inBatch?: boolean;
  /**
   * Resolver decision that admitted this tool call (when the route engaged
   * the permission resolver). One of "allow" / "ask" — "deny" / "defer"
   * short-circuit before withToolSpan opens. When the resolver was not
   * invoked (legacy callers without `permissions:`), this is "skipped".
   */
  permissionDecision?: "allow" | "ask" | "deny" | "defer" | "skipped";
  /** Resolver-supplied reason string for the decision (when present). */
  permissionReason?: string;
}

/**
 * Wrap a tool execution in an OTel span.
 *
 * Span name follows `tool.{toolId}` — these become Langfuse trace names.
 * Attributes use the `tool.*` prefix; `tool.duration_ms` is set regardless
 * of outcome. On thrown error the span gets ERROR status, the exception is
 * recorded, and the error re-throws so step.ts's existing post_tool_failure
 * dispatch + caller fall-through behaviour is preserved.
 */
export async function withToolSpan<T>(
  attrs: ToolSpanAttributes,
  fn: () => Promise<T>,
): Promise<T> {
  return await tracer.startActiveSpan(`tool.${attrs.toolId}`, async (span) => {
    span.setAttributes({
      "tool.id": attrs.toolId,
      "tool.read_only": attrs.readOnly ?? false,
      "tool.in_batch": attrs.inBatch ?? false,
    });
    if (attrs.permissionDecision) {
      span.setAttribute("permission.decision", attrs.permissionDecision);
      if (attrs.permissionReason) {
        span.setAttribute("permission.reason", attrs.permissionReason);
      }
    }
    const start = Date.now();
    try {
      const result = await fn();
      span.setAttribute("tool.duration_ms", Date.now() - start);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setAttribute("tool.duration_ms", Date.now() - start);
      const message = err instanceof Error ? err.message : String(err);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message,
      });
      span.recordException(err instanceof Error ? err : new Error(message));
      throw err;
    } finally {
      span.end();
    }
  });
}
