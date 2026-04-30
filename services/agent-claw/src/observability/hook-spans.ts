// Per-hook OTel span helper.
//
// Phase 9: every lifecycle.dispatch call wraps its handler in withHookSpan
// so Langfuse / OTLP receives a span per hook execution with point, name,
// matcher target, tool-use id, duration, and OK/ERROR status.
//
// When the OTel tracer provider is the default (no-op) one, startActiveSpan
// returns a no-op span and the wrapper still forwards the handler result —
// callers see no behavioural change. The OTLP exporter is wired in
// observability/otel.ts; this file only emits.

import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { HookPoint } from "../core/types.js";

const tracer = trace.getTracer("agent-claw.lifecycle");

export interface HookSpanAttributes {
  /** Lifecycle point being dispatched (pre_turn, pre_tool, …). */
  point: HookPoint;
  /** Diagnostic hook name registered via Lifecycle.on(). */
  hookName: string;
  /** String tested against the hook's matcher regex (typically toolId). */
  matcherTarget?: string;
  /** Tool-use identifier passed through DispatchOptions.toolUseID. */
  toolUseId?: string;
}

/**
 * Wrap a hook handler invocation in an OTel span.
 *
 * Span name follows `hook.{point}.{hookName}` — these become Langfuse trace
 * names. Attributes use the `hook.*` prefix; `hook.duration_ms` is set
 * regardless of outcome. On thrown error the span gets ERROR status, the
 * exception is recorded, and the error re-throws so dispatch semantics
 * (pre_tool throws abort the chain; other points log + continue) are
 * preserved by the caller.
 */
export async function withHookSpan<T>(
  attrs: HookSpanAttributes,
  fn: () => Promise<T>,
): Promise<T> {
  return await tracer.startActiveSpan(
    `hook.${attrs.point}.${attrs.hookName}`,
    async (span) => {
      span.setAttributes({
        "hook.point": attrs.point,
        "hook.name": attrs.hookName,
        ...(attrs.matcherTarget
          ? { "hook.matcher_target": attrs.matcherTarget }
          : {}),
        ...(attrs.toolUseId ? { "hook.tool_use_id": attrs.toolUseId } : {}),
      });
      const start = Date.now();
      try {
        const result = await fn();
        span.setAttribute("hook.duration_ms", Date.now() - start);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setAttribute("hook.duration_ms", Date.now() - start);
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
    },
  );
}
