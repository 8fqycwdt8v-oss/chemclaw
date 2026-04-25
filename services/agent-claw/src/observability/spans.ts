// Span helpers for agent-claw observability.
//
// Provides:
//   - startRootTurnSpan(opts) — opens a root span for one chat turn
//   - startToolSpan(parent, toolId) — opens a child span for one tool call
//   - startSubAgentSpan(parent, type) — opens a child span for a sub-agent
//   - recordLlmUsage(span, ...) — attaches token/cost attributes to a span
//   - recordSpanError(span, err) — marks a span as errored
//
// All spans are opened via the OTel tracer from otel.ts.
// When OTel is not configured, all operations are no-ops (the tracer returns
// a no-op span that ignores setAttribute / end calls).

import { context, trace, SpanStatusCode, type Span, type Context } from "@opentelemetry/api";
import { getTracer } from "./otel.js";

// ---------------------------------------------------------------------------
// Internal helper: extract an OTel Context with the given span set as current.
// ---------------------------------------------------------------------------

function contextWithSpan(span: Span): Context {
  return trace.setSpan(context.active(), span);
}

// ---------------------------------------------------------------------------
// Root span — one per chat turn
// ---------------------------------------------------------------------------

export interface RootSpanOptions {
  /** The agent_trace_id from the request (used as span name). */
  traceId: string;
  /** User identifier for the span attribute. */
  userEntraId: string;
  /** Model name used for this turn. */
  model?: string;
}

/**
 * Open a root span for one chat turn.
 * Caller must call span.end() when the turn completes.
 */
export function startRootTurnSpan(opts: RootSpanOptions): Span {
  const tracer = getTracer();
  const span = tracer.startSpan(`chat_turn:${opts.traceId}`);
  span.setAttribute("chemclaw.trace_id", opts.traceId);
  span.setAttribute("chemclaw.user", opts.userEntraId);
  if (opts.model) {
    span.setAttribute("llm.model", opts.model);
  }
  return span;
}

// ---------------------------------------------------------------------------
// Tool span — child span per tool call
// ---------------------------------------------------------------------------

/**
 * Open a child span for one tool execution.
 * Caller must call span.end() when the tool returns.
 *
 * @param parentSpan - The root turn span; the tool span is parented to it.
 */
export function startToolSpan(parentSpan: Span, toolId: string): Span {
  const tracer = getTracer();
  const ctx: Context = contextWithSpan(parentSpan);
  const span = tracer.startSpan(`tool:${toolId}`, undefined, ctx);
  span.setAttribute("chemclaw.tool_id", toolId);
  return span;
}

// ---------------------------------------------------------------------------
// Sub-agent span — child span for spawned sub-agents
// ---------------------------------------------------------------------------

/**
 * Open a child span for a sub-agent invocation.
 */
export function startSubAgentSpan(parentSpan: Span, agentType: string): Span {
  const tracer = getTracer();
  const ctx: Context = contextWithSpan(parentSpan);
  const span = tracer.startSpan(`sub_agent:${agentType}`, undefined, ctx);
  span.setAttribute("chemclaw.sub_agent_type", agentType);
  return span;
}

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

/**
 * Record LLM token usage and estimated cost on a span.
 */
export function recordLlmUsage(
  span: Span,
  opts: {
    promptTokens: number;
    completionTokens: number;
    estUsd?: number;
    model?: string;
    latencyMs?: number;
  },
): void {
  span.setAttribute("llm.prompt_tokens", opts.promptTokens);
  span.setAttribute("llm.completion_tokens", opts.completionTokens);
  span.setAttribute("llm.total_tokens", opts.promptTokens + opts.completionTokens);
  if (opts.estUsd !== undefined) {
    span.setAttribute("llm.est_usd", opts.estUsd);
  }
  if (opts.model) {
    span.setAttribute("llm.model", opts.model);
  }
  if (opts.latencyMs !== undefined) {
    span.setAttribute("llm.latency_ms", opts.latencyMs);
  }
}

/**
 * Mark a span as errored with the given error message.
 */
export function recordSpanError(span: Span, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
  span.setAttribute("error.message", message);
}
