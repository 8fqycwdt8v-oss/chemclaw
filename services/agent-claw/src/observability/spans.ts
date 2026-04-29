// Span helpers for agent-claw observability.
//
// Provides:
//   - startRootTurnSpan(opts) — opens a root span for one chat turn
//   - recordLlmUsage(span, ...) — attaches token/cost attributes to a span
//   - recordSpanError(span, err) — marks a span as errored
//
// All spans are opened via the OTel tracer from otel.ts.
// When OTel is not configured, all operations are no-ops (the tracer returns
// a no-op span that ignores setAttribute / end calls).

import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { getTracer } from "./otel.js";

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
  /** Active prompt name (e.g. "agent.system") — emitted as the
   * `prompt:<name>` Langfuse tag so the GEPA runner can fetch this trace
   * via `fetch_traces(tags=["prompt:agent.system"])`. */
  promptName?: string;
  /** Active prompt version, recorded alongside the prompt tag. */
  promptVersion?: number;
  /** Session id — emitted as `session.id` so Langfuse threads multi-turn
   * sessions in its UI. */
  sessionId?: string;
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
  // Langfuse OTel ingestion conventions — surface user/session/tags so the
  // UI groups traces correctly and GEPA's tag filter actually returns rows.
  span.setAttribute("user.id", opts.userEntraId);
  if (opts.model) {
    span.setAttribute("llm.model", opts.model);
  }
  if (opts.sessionId) {
    span.setAttribute("session.id", opts.sessionId);
    span.setAttribute("langfuse.session.id", opts.sessionId);
  }
  if (opts.promptName) {
    const tags: string[] = [`prompt:${opts.promptName}`];
    if (opts.promptVersion !== undefined) {
      tags.push(`prompt_version:${opts.promptVersion}`);
    }
    span.setAttribute("langfuse.trace.tags", tags);
    span.setAttribute("chemclaw.prompt_name", opts.promptName);
    if (opts.promptVersion !== undefined) {
      span.setAttribute("chemclaw.prompt_version", opts.promptVersion);
    }
  }
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
