// Phase 6: default permission hook.
//
// Registered at the permission_request lifecycle point as a no-op handler:
// returns {} so the resolver in core/permissions/resolver.ts falls back to
// the operator-supplied permissionCallback (or denies, per the spec).
//
// Operators wire custom policy by either:
//   1. Adding another hook at permission_request — multiple hooks aggregate
//      via deny>defer>ask>allow, so a deny from any hook wins.
//   2. Replacing this implementation with a policy-evaluating function.
//   3. Passing a permissionCallback in HarnessOptions.permissions.

import type { Lifecycle } from "../lifecycle.js";
import type { HookJSONOutput } from "../hook-output.js";
import type { PermissionRequestPayload } from "../types.js";

export async function permissionHook(
  _payload: PermissionRequestPayload,
  _toolUseID?: string,
  _options?: { signal: AbortSignal },
): Promise<HookJSONOutput> {
  // No-op: returns no decision so the resolver moves on to permissionCallback
  // (or denies if none is set). Replace with a real policy as needed.
  return {};
}

export function registerPermissionHook(lifecycle: Lifecycle): void {
  lifecycle.on("permission_request", "permission", permissionHook);
}
