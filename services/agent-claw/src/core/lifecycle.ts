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
  PermissionHookResult,
  PermissionRequestPayload,
  PermissionResolution,
  PostToolPayload,
  PostTurnPayload,
  PreCompactPayload,
  PreToolPayload,
  PreTurnPayload,
} from "./types.js";
import { withHookSpan } from "../observability/hook-spans.js";

// ---------------------------------------------------------------------------
// Phase 9: per-dispatch options for OTel span attribution.
//
// Currently the dispatcher only uses these to propagate `matcherTarget` and
// `toolUseID` onto the per-hook span; future phases (4A timeouts, hook
// matchers) may extend this struct without breaking existing call sites
// because every field is optional.
// ---------------------------------------------------------------------------
export interface DispatchOptions {
  /** String tested against a hook matcher regex (typically the toolId). */
  matcherTarget?: string;
  /** Tool-use identifier surfaced on hook spans + structured logs. */
  toolUseID?: string;
}

// ---------------------------------------------------------------------------
// Union of all payload types keyed by hook point.
// ---------------------------------------------------------------------------
type HookPayloadMap = {
  pre_turn: PreTurnPayload;
  pre_tool: PreToolPayload;
  post_tool: PostToolPayload;
  pre_compact: PreCompactPayload;
  post_turn: PostTurnPayload;
  permission_request: PermissionRequestPayload;
};

// Phase 6: permission_request hooks may return a PermissionHookResult, an
// "SDK-shape" object with hookSpecificOutput.permissionDecision, or void.
// Other hook points return Promise<void>.
export interface PermissionHookSdkShape {
  hookSpecificOutput?: {
    hookEventName?: "permission_request";
    permissionDecision?: PermissionResolution;
    permissionDecisionReason?: string;
  };
}

type HookReturnMap = {
  pre_turn: void;
  pre_tool: void;
  post_tool: void;
  pre_compact: void;
  post_turn: void;
  permission_request: PermissionHookResult | PermissionHookSdkShape | void;
};

// A handler for a specific hook point.
type HookHandler<P extends HookPoint> = (
  payload: HookPayloadMap[P],
) => Promise<HookReturnMap[P]>;

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
   * Returns the names of registered handlers at a given point, in
   * registration order. Used by the hook-loader-coverage parity test
   * to assert that each YAML file's `lifecycle:` matches the point
   * its registrar actually wires the handler to. Returns a copy so
   * callers can't mutate the internal array.
   */
  hookNames(point: HookPoint): string[] {
    const arr = this._hooks.get(point) ?? [];
    return arr.map((h) => h.name);
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
    opts?: DispatchOptions,
  ): Promise<void> {
    const hooks = this._hooks.get(point) ?? [];
    for (const hook of hooks) {
      // Phase 9: wrap every hook handler in an OTel span so Langfuse /
      // OTLP gets one span per invocation with point, name, matcher target,
      // tool-use id, duration, and OK/ERROR status. The wrapper re-throws
      // on handler failure so the dispatch-strict-vs-tolerant behaviour
      // below is unchanged.
      const invokeWithSpan = () =>
        withHookSpan(
          {
            point,
            hookName: hook.name,
            matcherTarget: opts?.matcherTarget,
            toolUseId: opts?.toolUseID,
          },
          () => (hook.handler as HookHandler<P>)(payload) as Promise<void>,
        );

      if (point === "pre_tool") {
        // Strict-throw semantics for pre_tool: a throwing hook aborts the
        // tool call (used by budget-guard, anti-fabrication, citation guard).
        await invokeWithSpan();
      } else {
        try {
          await invokeWithSpan();
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

  // ---------------------------------------------------------------------------
  // Phase 6: dispatchPermissionRequest — runs every registered handler at
  // permission_request and aggregates their decisions using deny>defer>ask>allow
  // precedence. The route-level resolver in core/permissions/resolver.ts is
  // the only caller. Hooks that throw are logged and skipped (a throwing
  // permission policy must not block tool execution silently — the resolver
  // falls through to permissionCallback or denies).
  // ---------------------------------------------------------------------------
  async dispatchPermissionRequest(
    payload: PermissionRequestPayload,
    opts?: DispatchOptions,
  ): Promise<PermissionHookResult | undefined> {
    const hooks = this._hooks.get("permission_request") ?? [];
    let aggregated: PermissionHookResult | undefined;

    for (const hook of hooks) {
      let raw: unknown;
      try {
        // Phase 9: span every permission_request handler invocation too.
        raw = await withHookSpan(
          {
            point: "permission_request",
            hookName: hook.name,
            matcherTarget: opts?.matcherTarget ?? payload.toolId,
            toolUseId: opts?.toolUseID,
          },
          () =>
            (hook.handler as HookHandler<"permission_request">)(
              payload,
            ) as Promise<unknown>,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[lifecycle] permission_request hook "${hook.name}" threw — skipping`,
          err,
        );
        continue;
      }

      const result = normalisePermissionResult(raw);
      if (!result) continue;

      aggregated = mostRestrictive(aggregated, result);
    }

    return aggregated;
  }
}

// ---------------------------------------------------------------------------
// Permission decision aggregation helpers.
// ---------------------------------------------------------------------------

// Permission decisions ordered most-restrictive first. The aggregator picks
// the first (most-restrictive) decision seen across all hooks.
const DECISION_PRIORITY: Record<PermissionResolution, number> = {
  deny: 0,
  defer: 1,
  ask: 2,
  allow: 3,
};

function mostRestrictive(
  a: PermissionHookResult | undefined,
  b: PermissionHookResult,
): PermissionHookResult {
  if (!a) return b;
  return DECISION_PRIORITY[b.decision] < DECISION_PRIORITY[a.decision] ? b : a;
}

function normalisePermissionResult(raw: unknown): PermissionHookResult | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;

  // Direct PermissionHookResult shape.
  if (typeof obj.decision === "string" && isResolution(obj.decision)) {
    return {
      decision: obj.decision,
      reason: typeof obj.reason === "string" ? obj.reason : undefined,
    };
  }

  // SDK-shape: { hookSpecificOutput: { permissionDecision, permissionDecisionReason } }.
  const hookSpecific = obj.hookSpecificOutput;
  if (hookSpecific && typeof hookSpecific === "object") {
    const hs = hookSpecific as Record<string, unknown>;
    const decision = hs.permissionDecision;
    if (typeof decision === "string" && isResolution(decision)) {
      const reason = hs.permissionDecisionReason;
      return {
        decision,
        reason: typeof reason === "string" ? reason : undefined,
      };
    }
  }

  return undefined;
}

function isResolution(s: string): s is PermissionResolution {
  return s === "allow" || s === "deny" || s === "ask" || s === "defer";
}
