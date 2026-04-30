// ---------------------------------------------------------------------------
// Error envelope builder + serializer.
//
// Shape (additive over the existing `{error, detail}` shape):
//
//   {
//     error:       <code>,         // stable string, see ERROR_CODES
//     message:     <human msg>,    // short human-readable summary
//     detail?:     <object|str>,   // optional structured detail
//     trace_id?:   <hex>,          // OTel trace id when a span is active
//     request_id?: <uuid>,         // x-request-id from RequestContext
//     hint?:       <string>,       // remediation hint when known
//   }
//
// Every consumer (SSE error frames, Fastify global error handler, the
// agent-side MCP client when it encounters a structured error response,
// the `error_events` DB sink) goes through `toEnvelope(err)` so the wire
// shape is identical wherever errors surface.
// ---------------------------------------------------------------------------

import { trace } from "@opentelemetry/api";

import { getRequestContext } from "../core/request-context.js";
import { ERROR_CODES, type ErrorCode } from "./codes.js";

export interface ErrorEnvelope {
  error: ErrorCode | string;
  message: string;
  detail?: unknown;
  trace_id?: string;
  request_id?: string;
  hint?: string;
}

/**
 * Type predicate for narrowing an unknown into something with `.message`.
 * Avoids the verbose `(err as Error)?.message` pattern at every call site.
 */
function asError(err: unknown): { name?: string; message?: string; stack?: string } {
  if (err && typeof err === "object") return err as { name?: string; message?: string; stack?: string };
  return {};
}

interface ToEnvelopeOptions {
  /** Override the default `AGENT_INTERNAL` fallback code for unrecognised errors. */
  fallbackCode?: ErrorCode;
  /** Optional remediation hint to attach. */
  hint?: string;
  /** Optional structured detail to attach (already-redacted). */
  detail?: unknown;
}

const KNOWN_ERROR_CLASS_TO_CODE: Record<string, ErrorCode> = {
  BudgetExceededError: ERROR_CODES.AGENT_BUDGET_EXCEEDED,
  SessionBudgetExceededError: ERROR_CODES.SESSION_BUDGET_EXCEEDED,
  AwaitingUserInputError: ERROR_CODES.AGENT_AWAITING_USER_INPUT,
  OptimisticLockError: ERROR_CODES.AGENT_OPTIMISTIC_LOCK,
  MissingUserError: ERROR_CODES.AGENT_UNAUTHENTICATED,
  PaperclipBudgetError: ERROR_CODES.PAPERCLIP_BUDGET_DENIED,
  AbortError: ERROR_CODES.AGENT_CANCELLED,
};

/**
 * Build an error envelope from any value. Recognised error subclasses map
 * to their specific code; everything else falls back to AGENT_INTERNAL
 * (or the caller-supplied fallback). Trace + request ids are pulled from
 * the active OTel span / RequestContext when available.
 */
export function toEnvelope(err: unknown, options: ToEnvelopeOptions = {}): ErrorEnvelope {
  const e = asError(err);
  const fallback = options.fallbackCode ?? ERROR_CODES.AGENT_INTERNAL;
  const mapped = e.name ? KNOWN_ERROR_CLASS_TO_CODE[e.name] : undefined;
  const code: ErrorCode | string = mapped ?? fallback;
  const message = e.message ?? "internal error";

  const out: ErrorEnvelope = {
    error: code,
    message,
  };
  if (options.detail !== undefined) out.detail = options.detail;
  if (options.hint) out.hint = options.hint;

  // Correlation IDs — same pulls as the Pino mixin.
  const ctx = getRequestContext();
  if (ctx?.requestId) out.request_id = ctx.requestId;

  const span = trace.getActiveSpan();
  if (span) {
    const sc = span.spanContext();
    if (sc.traceId && /[1-9a-f]/.test(sc.traceId)) {
      out.trace_id = sc.traceId;
    }
  }

  return out;
}

/**
 * Build an envelope from a known code + message directly. Use when the
 * caller already knows the code (e.g. a precondition check failed) and
 * doesn't have an Error object to dispatch from.
 */
export function envelopeFor(
  code: ErrorCode,
  message: string,
  extras: Omit<ToEnvelopeOptions, "fallbackCode"> = {},
): ErrorEnvelope {
  // toEnvelope's class-name dispatch ignores `code` from a synthetic
  // Error, so build the shape by hand to keep the requested code stable.
  const out: ErrorEnvelope = { error: code, message };
  if (extras.detail !== undefined) out.detail = extras.detail;
  if (extras.hint) out.hint = extras.hint;

  const ctx = getRequestContext();
  if (ctx?.requestId) out.request_id = ctx.requestId;

  const span = trace.getActiveSpan();
  if (span) {
    const sc = span.spanContext();
    if (sc.traceId && /[1-9a-f]/.test(sc.traceId)) {
      out.trace_id = sc.traceId;
    }
  }
  return out;
}
