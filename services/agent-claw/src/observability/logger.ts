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
// ---------------------------------------------------------------------------

import { pino, type Logger } from "pino";

import { logContextFields } from "./log-context.js";

// Defense-in-depth redaction. Pino's `redact` paths apply BEFORE the JSON
// formatter, so secrets in known-shape fields are scrubbed even if a caller
// accidentally logs a raw header object or tool input. The list expands the
// original (Authorization / Cookie) with fields that frequently carry
// chemistry-sensitive content (raw SMILES, prompts, tool input/output) so
// they're at least filtered when they pass through the logger; the
// LiteLLM-redactor backed log filter catches free-form prose.
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
];

let _root: Logger | null = null;

function buildRoot(): Logger {
  const level = process.env.AGENT_LOG_LEVEL ?? "info";
  return pino({
    level,
    base: { service: "agent-claw" },
    redact: { paths: ROOT_REDACT_PATHS, censor: "***" },
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
