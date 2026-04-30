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

const ROOT_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.authorization",
  "*.cookie",
];

let _root: Logger | null = null;

function buildRoot(): Logger {
  const level = process.env["AGENT_LOG_LEVEL"] ?? "info";
  return pino({
    level,
    base: { service: "agent-claw" },
    redact: { paths: ROOT_REDACT_PATHS, censor: "***" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/**
 * Returns the process-wide root logger. With a `component` argument it
 * returns a child logger so structured queries like
 * `component=ToolRegistry level>=warn` work in the log shipper.
 */
export function getLogger(component?: string): Logger {
  if (_root === null) _root = buildRoot();
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
