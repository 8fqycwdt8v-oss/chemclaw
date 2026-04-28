// Hook registry + dispatch for the lifecycle points.
// Phase 4A: hooks now follow the Claude Agent SDK contract. Each handler
// receives (input, toolUseID, { signal }) and returns Promise<HookJSONOutput>.
//
// Per-hook AbortController + timeout (default 60s): if a hook doesn't return
// in time, its signal aborts so cooperative handlers can bail. Hooks that
// don't honour the signal will still hold the dispatcher hostage — this is
// "best-effort" abort, matching the SDK behaviour.
//
// Per-point semantics:
//   - pre_tool: a thrown error propagates (preserves budget-guard semantics).
//     A hook that wants to deny softly should return permissionDecision:"deny".
//   - All other points: a thrown error is logged and the next hook runs.
//     Subsequent hooks (e.g. redact-secrets at post_turn) MUST run even if
//     an earlier one fails.
//
// dispatch() aggregates decisions across multiple hooks at the same point
// using deny > defer > ask > allow precedence. updatedInput from any hook
// flows back to the caller; the caller (step.ts) decides what to do with it.

import type {
  HookCallback,
  HookJSONOutput,
  PermissionDecision,
} from "./hook-output.js";
import { mostRestrictive } from "./hook-output.js";
import type { HookPayloadMap, HookPoint } from "./types.js";

// Internal: store each handler with a name + matcher + per-hook timeout.
interface RegisteredHook<P> {
  name: string;
  matcher?: RegExp;
  handler: HookCallback<P>;
  timeout: number;
}

export interface DispatchOptions {
  /** Tool-use identifier passed to handlers (typically the toolId for pre/post_tool). */
  toolUseID?: string;
  /**
   * String tested against each hook's matcher regex. If a hook has a matcher
   * and this target is provided, the hook only runs when the regex matches.
   * If a hook has a matcher and matcherTarget is undefined, the hook is
   * skipped (no implicit match).
   */
  matcherTarget?: string;
}

export interface DispatchResult {
  /** Aggregate decision across all hooks at this point (deny>defer>ask>allow). */
  decision?: PermissionDecision;
  /** Reason from whichever hook produced the most-restrictive decision. */
  reason?: string;
  /**
   * Last-write-wins updated input from a pre_tool hook. step.ts re-parses
   * this through the tool's input schema before execution.
   */
  updatedInput?: Record<string, unknown>;
}

// Default per-hook timeout: 60s, matching the Claude Agent SDK default.
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

export class Lifecycle {
  // Map<point, RegisteredHook<unknown>[]> — payloads are erased at storage
  // time and re-narrowed at dispatch time via the generic.
  private readonly _hooks: Map<HookPoint, RegisteredHook<unknown>[]> = new Map();

  /**
   * Register a hook handler for the given lifecycle point.
   *
   * @param point   One of the lifecycle hook points.
   * @param name    Diagnostic name; shown in logs.
   * @param handler Async callback returning HookJSONOutput.
   * @param opts    Optional matcher (regex string tested against
   *                dispatchOptions.matcherTarget) + per-hook timeout (ms).
   */
  on<P extends HookPoint>(
    point: P,
    name: string,
    handler: HookCallback<HookPayloadMap[P]>,
    opts: { matcher?: string; timeout?: number } = {},
  ): this {
    if (!this._hooks.has(point)) {
      this._hooks.set(point, []);
    }
    this._hooks.get(point)!.push({
      name,
      matcher: opts.matcher ? new RegExp(opts.matcher) : undefined,
      handler: handler as HookCallback<unknown>,
      timeout: opts.timeout ?? DEFAULT_HOOK_TIMEOUT_MS,
    });
    return this;
  }

  /**
   * Returns the number of registered handlers for a given point.
   */
  count(point: HookPoint): number {
    return this._hooks.get(point)?.length ?? 0;
  }

  /**
   * Remove all hooks (or only those at a specific point).
   * Useful in tests.
   */
  clear(point?: HookPoint): void {
    if (point) {
      this._hooks.delete(point);
    } else {
      this._hooks.clear();
    }
  }

  /**
   * Dispatch a lifecycle event.
   *
   * Iterates registered handlers for the point in registration order:
   *   - Skips a hook whose matcher doesn't match `opts.matcherTarget`.
   *   - Runs the handler with a per-call AbortSignal that fires when the
   *     hook's timeout elapses.
   *   - For pre_tool, a thrown error propagates immediately (legacy
   *     budget-guard semantics). For all other points, errors are logged
   *     and the next hook runs.
   *   - { async: true } returns are ignored — the hook is fire-and-forget.
   *   - permissionDecision values are aggregated via deny>defer>ask>allow;
   *     reason follows whichever hook upgraded the decision.
   *   - updatedInput from any hook is captured (last-write-wins).
   */
  async dispatch<P extends HookPoint>(
    point: P,
    payload: HookPayloadMap[P],
    opts: DispatchOptions = {},
  ): Promise<DispatchResult> {
    const hooks = this._hooks.get(point) ?? [];
    let decision: PermissionDecision | undefined;
    let reason: string | undefined;
    let updatedInput: Record<string, unknown> | undefined;

    for (const hook of hooks) {
      // Matcher gate: if the hook has a regex matcher, only run when a
      // target string is supplied AND it matches. No target = skip (the
      // hook explicitly opted into matcher-gated dispatch).
      if (hook.matcher) {
        if (!opts.matcherTarget || !hook.matcher.test(opts.matcherTarget)) {
          continue;
        }
      }

      const ac = new AbortController();
      const timer = setTimeout(
        () => ac.abort(new Error(`hook timeout: ${hook.name}`)),
        hook.timeout,
      );

      try {
        // Race the handler against an abort-rejection promise so that a
        // misbehaving hook (one that ignores its AbortSignal) cannot stall
        // the dispatcher beyond `hook.timeout`. The hook keeps running in
        // the background — we cannot kill its event-loop work — but the
        // dispatcher unblocks, the timeout error path runs, and the next
        // hook fires on schedule.
        const handlerPromise = (
          hook.handler as HookCallback<unknown>
        )(payload, opts.toolUseID, { signal: ac.signal });
        const abortPromise = new Promise<never>((_, reject) => {
          if (ac.signal.aborted) {
            reject(
              ac.signal.reason ??
                new Error(`hook timeout: ${hook.name}`),
            );
            return;
          }
          ac.signal.addEventListener(
            "abort",
            () => {
              reject(
                ac.signal.reason ??
                  new Error(`hook timeout: ${hook.name}`),
              );
            },
            { once: true },
          );
        });
        const result: HookJSONOutput | undefined | void = await Promise.race([
          handlerPromise,
          abortPromise,
        ]);

        // Tolerate hooks that return nothing (legacy void-returning shape
        // surfaced by older tests and any third-party hook that hasn't
        // migrated yet). Treat as a no-op success.
        if (!result) continue;

        // Fire-and-forget: ignore the result, move to the next hook.
        if ("async" in result && result.async) continue;

        // After the async-branch guard, `result` is the synchronous-shape
        // variant. Pick out hookSpecificOutput as the loosely-typed object
        // it is on the wire — its inner fields are then narrowed below.
        const hso = (result as { hookSpecificOutput?: unknown }).hookSpecificOutput as
          | {
              permissionDecision?: PermissionDecision;
              permissionDecisionReason?: string;
              updatedInput?: Record<string, unknown>;
            }
          | undefined;

        // Aggregate permission decision.
        const dec = hso?.permissionDecision;
        if (dec) {
          const next = mostRestrictive(decision, dec);
          if (next !== decision) {
            decision = next;
            reason = hso?.permissionDecisionReason;
          }
        }

        // Capture updatedInput (last-write-wins).
        if (hso?.updatedInput) updatedInput = hso.updatedInput;
      } catch (err) {
        if (point === "pre_tool") {
          // Strict-throw semantics for pre_tool: budget-guard etc. abort
          // the tool call by throwing.
          throw err;
        }
        // eslint-disable-next-line no-console
        console.error(
          `[lifecycle] non-pre_tool hook "${hook.name}" at "${point}" threw — continuing with remaining hooks`,
          err,
        );
      } finally {
        clearTimeout(timer);
      }
    }

    return { decision, reason, updatedInput };
  }
}
