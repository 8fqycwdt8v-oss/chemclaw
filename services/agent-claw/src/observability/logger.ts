// ---------------------------------------------------------------------------
// Centralised Pino logger for the agent harness.
//
// Why this exists
// ---------------
// Fastify owns its own Pino logger (configured in `src/index.ts`). That
// instance is great for HTTP request logs but it is only reachable through
// the Fastify app object — code that runs outside of a request scope (the
// hook lifecycle, `tools/registry.ts`, `core/step.ts`, builtins, the OTel
// span emitters) has no easy hook into it. Before this module those call
// sites fell back to `console.warn` / `console.error`, which:
//   - bypassed Pino's redaction (so secrets in error messages would leak),
//   - produced unstructured text that the audit log shipper could not key on,
//   - and made request-correlation impossible in shared logs.
//
// `getLogger()` returns a process-wide root logger; `getLogger(component)`
// returns a child bound to a `{ component }` field so log entries can be
// filtered. The level is controlled by `AGENT_LOG_LEVEL` (same env var the
// Fastify logger reads) and defaults to `info` so production never silently
// drops warnings. Tests can clear the cache with `__resetLoggerForTests`.
//
// Content-aware redaction (cycle 4): the Pino path-based redact list catches
// known-shape fields by name, but Postgres/MCP errors carry SMILES + compound
// codes embedded in driver-provided "Failing row contains (...)" strings
// inside `err.message` and `err.stack`. Pino's `redact` does NOT regex over
// values — only paths — so we install custom serializers that pass error
// strings through `scrub()` (the same regex pipeline the post_turn hook uses)
// before Pino formats them. This closes the BACKLOG cluster-6 finding without
// leaking new state into the hot path: the regex set is length-bounded, and
// the same input cap as the egress redactor (5 MB) bounds worst-case CPU.
// ---------------------------------------------------------------------------

import { pino, type Logger } from "pino";

import { logContextFields } from "./log-context.js";
import { scrub } from "./redact-string.js";

// Pino's redact-path syntax — fields scrubbed with "***" before serialization.
//
// Conservative list: covers fields that frequently carry chemistry-sensitive
// content (SMILES, prompts, tool I/O) AND error-detail channels (Postgres
// "detail", upstream-error "detail"). The free-form err.message / err.stack
// channels are scrubbed via the `err` serializer below — Pino's path
// redaction can't run regex over values.
const ROOT_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.authorization",
  "*.cookie",
  "*.password",
  "*.token",
  "*.api_key",
  "*.apiKey",
  "tool_input.smiles",
  "tool_output.smiles",
  "messages[*].content",
  "prompt",
  "raw_user",
  "err.detail",
  "*.detail",
];

/**
 * Custom error serializer: replaces Pino's default by passing message and
 * stack through `scrub()` so SMILES / compound-codes / emails / NCE-IDs
 * embedded in driver error strings are masked before they hit the log
 * shipper. Mirrors `pino.stdSerializers.err` for the rest of the shape so
 * downstream Loki queries that key on `err.type` / `err.code` keep working.
 *
 * Returning a plain object (not the Error) is critical — Pino otherwise
 * special-cases Error and bypasses the serializer's return value. Same
 * convention used by `pino.stdSerializers.err`.
 */
function serializeError(err: unknown): Record<string, unknown> {
  if (err === null || err === undefined) {
    return { type: "unknown", message: "" };
  }
  if (typeof err !== "object") {
    // `getLogger().error("string-only error")` → primitive falls through
    // unchanged; nothing to scrub.
    return {
      type: typeof err,
      message: typeof err === "string" ? err : JSON.stringify(err),
    };
  }
  const e = err as Error & {
    code?: unknown;
    statusCode?: unknown;
    detail?: unknown;
    cause?: unknown;
    [key: string]: unknown;
  };
  const out: Record<string, unknown> = {
    type: typeof e.name === "string" && e.name.length > 0 ? e.name : "Error",
    message: typeof e.message === "string" ? scrub(e.message) : "",
  };
  if (typeof e.stack === "string") {
    // Stack frames frequently quote the offending value (e.g. inside a
    // template literal in a route handler). Scrub the whole stack — frame
    // pointers (file:line) survive because the regex set is length-bounded
    // and only matches identifier-shaped tokens, never path segments.
    out.stack = scrub(e.stack);
  }
  if (e.code !== undefined) out.code = e.code;
  if (e.statusCode !== undefined) out.statusCode = e.statusCode;
  // err.detail is already scrubbed by the path-redact list above; copy it
  // through unchanged so the redaction censor (***) is what surfaces.
  if (e.detail !== undefined) out.detail = e.detail;
  if (e.cause !== undefined) {
    // Recursively serialize cause chain; cap at one level so a malicious
    // cause-loop can't blow the log shipper's stack.
    out.cause =
      e.cause instanceof Error
        ? serializeError(e.cause)
        : typeof e.cause === "string"
          ? scrub(e.cause)
          : e.cause;
  }
  return out;
}

let _root: Logger | null = null;

function buildRoot(): Logger {
  const level = process.env.AGENT_LOG_LEVEL ?? "info";
  return pino({
    level,
    base: { service: "agent-claw" },
    redact: { paths: ROOT_REDACT_PATHS, censor: "***" },
    serializers: {
      // Replace the default Error serializer so message/stack are scrubbed
      // before the JSON formatter runs. Pino calls this whenever a logged
      // object has an `err` field of type Error (the common pattern is
      // `log.error({ err }, "...")`).
      err: serializeError,
      // Same shape, different name — some call sites use `error` instead
      // of `err` (e.g. legacy fastify reply context fields).
      error: serializeError,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Auto-enrich every record with correlation fields when an HTTP request
    // / OTel span is active. Returning {} when nothing is available is a
    // no-op for Pino. The mixin is called per-call, not per-instance, so
    // child loggers inherit it automatically.
    mixin: () => logContextFields(),
  });
}

/**
 * Returns the process-wide root logger. With a `component` argument it
 * returns a child logger so structured queries like
 * `component=ToolRegistry level>=warn` work in the log shipper.
 */
export function getLogger(component?: string): Logger {
  _root ??= buildRoot();
  if (component === undefined) return _root;
  return _root.child({ component });
}

/**
 * Test-only hook — drops the cached root so a subsequent `getLogger()` rebuilds
 * with whatever `AGENT_LOG_LEVEL` is set in the test process.
 */
export function __resetLoggerForTests(): void {
  _root = null;
}
