// Request-scoped context propagated via AsyncLocalStorage.
//
// Why ALS instead of threading explicit args: the userEntraId needs to reach
// every outbound MCP call so the JWT can be minted with the right `user`
// claim. Threading it through 21 builtin tool factories + the harness +
// every postJson/getJson site is 30+ edits and a maintenance burden every
// time a new tool ships. ALS makes propagation automatic — the harness
// sets it once per turn, postJson reads it transparently.
//
// Tradeoff: ALS context can be lost if a tool spawns a non-awaited promise
// (.catch() detachment, fire-and-forget setTimeouts). For our codebase that's
// not a concern — every async boundary is awaited.
//
// Test-friendly: `getRequestContext()` returns undefined outside an ALS run,
// which makes postJson behave as if no auth is configured (matches dev mode).

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** Entra-ID of the calling user — flows into JWT `user` claim. */
  userEntraId: string;
  /** Active session id (if any) — useful for log correlation. */
  sessionId?: string;
  /**
   * Upstream AbortSignal threaded through from the route's FastifyRequest.
   * postJson / getJson in `mcp/postJson.ts` read this to cancel in-flight
   * MCP calls when the originating client disconnects mid-stream. Optional
   * — background tasks (reanimator, optimizer) and tests run without an
   * upstream signal and the helpers fall back to their own per-call timeout
   * AbortController as before.
   */
  signal?: AbortSignal;
}

const _storage = new AsyncLocalStorage<RequestContext>();

/**
 * Read the current request context. Returns undefined when called outside
 * `runWithRequestContext` — that's the test/standalone path.
 */
export function getRequestContext(): RequestContext | undefined {
  return _storage.getStore();
}

/**
 * Run `fn` inside a request context. The context is available to every
 * async function awaited from within `fn` (via Node's async-hooks).
 */
export function runWithRequestContext<T>(
  ctx: RequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return _storage.run(ctx, fn);
}
