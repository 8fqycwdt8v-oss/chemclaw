// Hook registry + dispatch for the five lifecycle points.
// Phase A.1: programmatic registration only (YAML loading lands in A.3).
//
// Design: hooks are async functions registered by name. Multiple hooks can
// share a point; they run sequentially in registration order. A pre_tool hook
// may throw to abort the tool call — the error propagates to runHarness which
// catches it and surfaces it as a step error. Hooks that mutate payload fields
// do so in-place (the payload is passed by reference).

import type {
  HookPoint,
  PostCompactPayload,
  PostToolPayload,
  PostTurnPayload,
  PreCompactPayload,
  PreToolPayload,
  PreTurnPayload,
} from "./types.js";

// ---------------------------------------------------------------------------
// Union of all payload types keyed by hook point.
// ---------------------------------------------------------------------------
type HookPayloadMap = {
  pre_turn: PreTurnPayload;
  pre_tool: PreToolPayload;
  post_tool: PostToolPayload;
  pre_compact: PreCompactPayload;
  post_compact: PostCompactPayload;
  post_turn: PostTurnPayload;
};

// A handler for a specific hook point.
type HookHandler<P extends HookPoint> = (
  payload: HookPayloadMap[P],
) => Promise<void>;

// Internal: store each handler with a name for diagnostics.
interface RegisteredHook<P extends HookPoint> {
  name: string;
  handler: HookHandler<P>;
}

// ---------------------------------------------------------------------------
// Lifecycle — the dispatcher.
// ---------------------------------------------------------------------------
export class Lifecycle {
  // Use a map of arrays; the union is too wide for the generic so we use
  // Map<string, RegisteredHook<any>[]> and cast at dispatch time.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _hooks: Map<HookPoint, RegisteredHook<any>[]> = new Map();

  /**
   * Register a hook handler for the given lifecycle point.
   *
   * @param point  One of the five lifecycle hook points.
   * @param name   Diagnostic name; shown in logs.
   * @param handler Async function invoked at that point. For pre_tool, may throw to abort.
   */
  on<P extends HookPoint>(
    point: P,
    name: string,
    handler: HookHandler<P>,
  ): this {
    if (!this._hooks.has(point)) {
      this._hooks.set(point, []);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this._hooks.get(point)!.push({ name, handler });
    return this;
  }

  /**
   * Remove all hooks for a given point (useful in tests).
   */
  clear(point?: HookPoint): void {
    if (point) {
      this._hooks.delete(point);
    } else {
      this._hooks.clear();
    }
  }

  /**
   * Returns the number of registered handlers for a given point.
   */
  count(point: HookPoint): number {
    return this._hooks.get(point)?.length ?? 0;
  }

  /**
   * Dispatch a lifecycle event. All registered handlers for the given point
   * are called sequentially (in registration order).
   *
   * For pre_tool: if any handler throws, the error propagates immediately
   * (remaining handlers for that point are skipped). This is intentional —
   * a budget-guard hook that throws aborts the tool call.
   *
   * For all other points (pre_turn, post_tool, pre_compact, post_turn):
   * a thrown error is logged and the next hook is invoked. We do NOT abort
   * the whole turn just because (e.g.) tag-maturity has a transient DB
   * hiccup, and we MUST not skip subsequent hooks (such as the redact-secrets
   * post_turn pass) on a transient failure of an earlier hook.
   */
  async dispatch<P extends HookPoint>(
    point: P,
    payload: HookPayloadMap[P],
  ): Promise<void> {
    const hooks = this._hooks.get(point) ?? [];
    for (const hook of hooks) {
      if (point === "pre_tool") {
        // Strict-throw semantics for pre_tool: a throwing hook aborts the
        // tool call (used by budget-guard, anti-fabrication, citation guard).
        await (hook.handler as HookHandler<P>)(payload);
      } else {
        try {
          await (hook.handler as HookHandler<P>)(payload);
        } catch (err) {
          // Best-effort logging — we use console here because the lifecycle
          // is platform-agnostic. Routes that have a Fastify logger should
          // observe these errors via Langfuse spans (instrumented at the
          // hook implementation site).
          // eslint-disable-next-line no-console
          console.error(
            `[lifecycle] non-pre_tool hook "${hook.name}" at "${point}" threw — continuing with remaining hooks`,
            err,
          );
        }
      }
    }
  }
}
