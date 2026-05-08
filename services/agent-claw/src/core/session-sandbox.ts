// Per-session E2B sandbox cache.
//
// run_program and forged-tool dispatch otherwise create + close a fresh
// E2B sandbox per call. The sandbox spin-up is the dominant latency for
// any short Python invocation (40s ceiling, typically tens of seconds).
// When a single agent session executes multiple Python tool calls in a
// row — common for chained-execution and code-mode interleaved with
// run_program — paying that cost on every call is wasteful.
//
// This helper caches one sandbox handle on the per-session scratchpad
// and reuses it across calls within the same session. The session_end
// hook (registered alongside this module) closes the cached handle when
// the session terminates.
//
// Safety:
//   - Each call still writes its own /sandbox/_run.py and execs python3
//     in a fresh subprocess, so global Python state cannot leak between
//     calls. The chemclaw stub is re-mounted per call (cheap; same
//     bytes), so a tampered stub from a prior call cannot persist.
//   - The /sandbox filesystem is shared. Tools that write artifacts
//     intended to outlive the call (rare) get them; tools that don't
//     are still safe because outputs are extracted from stdout, not
//     filesystem listings of arbitrary paths.
//   - Re-use is opt-in: only routes that explicitly attach a session
//     scratchpad slot get the cache. Tests, sub-agents, and one-shot
//     calls fall through to the per-call create/close path.

import type { SandboxClient, SandboxHandle } from "./sandbox.js";
import type { ToolContext } from "./types.js";
import { getLogger } from "../observability/logger.js";

/**
 * Scratchpad slot name. Keep stable — the session_end hook reads the
 * same key.
 */
const SLOT = "__chemclaw_e2b_session_sandbox";

interface CachedSandbox {
  handle: SandboxHandle;
  /** Stub paths that have already been mounted on this sandbox (avoids
   *  redundant writes when the same forged tool runs back to back). */
  mountedStubs: Set<string>;
}

/**
 * Runtime guard on the scratchpad slot. The slot key is namespaced
 * (`__chemclaw_e2b_session_sandbox`) so collision is unlikely, but a
 * future writer that puts something else there would otherwise crash
 * acquireSessionSandbox with a confusing `.mountedStubs.has is not a
 * function`. A stricter "wrong shape" branch logs + ignores so we
 * fall through to creating a fresh sandbox.
 */
function isCachedSandbox(value: unknown): value is CachedSandbox {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const handle = v.handle;
  if (typeof handle !== "object" || handle === null) return false;
  const handleId = (handle as Record<string, unknown>).id;
  return typeof handleId === "string" && v.mountedStubs instanceof Set;
}

export interface SessionSandboxLease {
  handle: SandboxHandle;
  /** True when this call should mount the chemclaw stub before exec. */
  needsStubMount: boolean;
  /** Mark a stub path as mounted so subsequent calls in this session can skip. */
  recordStubMounted: (path: string) => void;
  /**
   * Returns true when the caller owns the sandbox lifecycle — single-use
   * fallback path where the caller MUST close the sandbox in finally.
   * False when the sandbox is session-cached and the session_end hook
   * will close it.
   */
  callerOwnsLifecycle: boolean;
}

/**
 * Acquire a sandbox for a tool call. If the calling context has a
 * session scratchpad, the sandbox is cached on it and reused for
 * subsequent calls in the same session. Otherwise a one-shot sandbox is
 * returned and the caller must close it in finally.
 *
 * The `stubKey` is an arbitrary string identifying the stub library
 * mounted at /sandbox/chemclaw/__init__.py — pass the same key on every
 * call that mounts the same stub so we can skip re-mounts. A different
 * key (e.g. "forged_tool_v2") forces a re-mount on the next call.
 */
export async function acquireSessionSandbox(
  ctx: ToolContext,
  client: SandboxClient,
  stubKey: string,
): Promise<SessionSandboxLease> {
  const cachedRaw = ctx.scratchpad.get(SLOT);
  if (cachedRaw !== undefined && !isCachedSandbox(cachedRaw)) {
    getLogger("agent-claw.core.session_sandbox").warn(
      { event: "session_sandbox_slot_wrong_shape" },
      "scratchpad slot held a non-CachedSandbox value — ignoring and creating fresh",
    );
    ctx.scratchpad.delete(SLOT);
  }
  const cached = isCachedSandbox(cachedRaw) ? cachedRaw : undefined;
  if (cached) {
    const needsStubMount = !cached.mountedStubs.has(stubKey);
    return {
      handle: cached.handle,
      needsStubMount,
      recordStubMounted: (path) => {
        cached.mountedStubs.add(path);
      },
      callerOwnsLifecycle: false,
    };
  }
  const handle = await client.createSandbox();
  // Only stash on scratchpad if the route opted in by setting the
  // sentinel flag. Otherwise this is a one-shot tool call (test,
  // sub-agent, non-session route) — don't pollute the scratchpad with
  // a sandbox the session_end hook will never close.
  const enabled = ctx.scratchpad.get("__chemclaw_e2b_session_cache_enabled") === true;
  if (enabled) {
    const entry: CachedSandbox = {
      handle,
      mountedStubs: new Set<string>(),
    };
    ctx.scratchpad.set(SLOT, entry);
    return {
      handle,
      needsStubMount: true,
      recordStubMounted: (path) => entry.mountedStubs.add(path),
      callerOwnsLifecycle: false,
    };
  }
  return {
    handle,
    needsStubMount: true,
    recordStubMounted: () => {},
    callerOwnsLifecycle: true,
  };
}

/**
 * Mark a context as cache-enabled. Call this in the chat/SSE route
 * after building ctx but before runHarness. Without this flag any
 * sandbox stays single-use even when the route has a sessionId.
 */
export function enableSessionSandboxCache(ctx: ToolContext): void {
  ctx.scratchpad.set("__chemclaw_e2b_session_cache_enabled", true);
}

/**
 * Close any cached sandbox referenced by the scratchpad. Idempotent;
 * safe to call multiple times. Fired from the session-sandbox-close
 * hook on session_end and also exposed for test/manual cleanup.
 */
export async function closeSessionSandbox(
  ctx: ToolContext,
  client: SandboxClient,
): Promise<void> {
  const cachedRaw = ctx.scratchpad.get(SLOT);
  if (!isCachedSandbox(cachedRaw)) {
    // Either no slot at all (idempotent) or wrong-shape — clear and exit.
    if (cachedRaw !== undefined) ctx.scratchpad.delete(SLOT);
    return;
  }
  const cached = cachedRaw;
  ctx.scratchpad.delete(SLOT);
  try {
    await client.closeSandbox(cached.handle);
  } catch (err) {
    getLogger("agent-claw.core.session_sandbox").warn(
      {
        event: "session_sandbox_close_failed",
        sandbox_id: cached.handle.id,
        err_msg: (err as Error).message,
      },
      "session-cached sandbox close failed",
    );
  }
}
