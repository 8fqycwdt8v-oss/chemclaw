// ---------------------------------------------------------------------------
// Log-context mixin: pulls correlation fields onto every Pino log record.
//
// Pino lets you register a `mixin` callback that runs at every log call and
// returns extra fields. We use it to copy three things onto every record
// emitted within an HTTP request:
//   - request_id  (from RequestContext, propagated via X-Request-Id header)
//   - session_id  (from RequestContext)
//   - user        (sha256-hashed entra id, never raw)
//   - trace_id    (from the active OTel span, when one is active)
//
// This is decoupled from the Fastify request log channel so code that runs
// outside the request scope (registry, step, hooks, builtins, the OTel span
// emitters) gets the same enrichment automatically. The mixin reads from
// AsyncLocalStorage which already threads through every awaited async path.
//
// Mirrored on the Python side in `services/mcp_tools/common/log_context.py`,
// which uses contextvars + a logging.Filter for the same effect.
// ---------------------------------------------------------------------------

import { trace } from "@opentelemetry/api";

import { getRequestContext } from "../core/request-context.js";
import { hashUser } from "./user-hash.js";

export interface LogContextFields {
  request_id?: string;
  session_id?: string;
  user?: string;
  trace_id?: string;
}

/**
 * Compute the correlation fields to merge onto a Pino record. Returns an
 * object with only the fields that have a value — empty objects are
 * filtered out by Pino's mixin contract.
 */
export function logContextFields(): LogContextFields {
  const out: LogContextFields = {};

  const ctx = getRequestContext();
  if (ctx) {
    if (ctx.requestId) out.request_id = ctx.requestId;
    if (ctx.sessionId) out.session_id = ctx.sessionId;
    // Prefer the precomputed hash on RequestContext (cached at the
    // route wrapper) — falls back to live-hashing when the route
    // didn't supply one (test paths, background helpers). Avoids a
    // sha256 computation on every log emission.
    const userHash = ctx.userHash ?? hashUser(ctx.userEntraId);
    if (userHash) out.user = userHash;
  }

  // Only attach trace_id when there's actually an active span. Pulling the
  // tracer's no-op span and emitting "00000000..." would just be noise.
  const span = trace.getActiveSpan();
  if (span) {
    const sc = span.spanContext();
    // Filter out the all-zeros invalid trace id (no-op tracer fallback).
    if (sc.traceId && /[1-9a-f]/.test(sc.traceId)) {
      out.trace_id = sc.traceId;
    }
  }

  return out;
}
