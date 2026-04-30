// Phase 3 of the configuration concept (Initiative 5).
//
// DB-backed permission hook. Reads permission_policies via
// PermissionPolicyLoader (60s TTL cache) and returns a HookJSONOutput
// {decision, reason} when a policy matches the current call. The lifecycle
// aggregator (deny>defer>ask>allow) then composes this hook's decision
// with any other hook installed at permission_request.
//
// When the loader singleton isn't set up (unit tests), behaviour falls
// back to the original no-op so legacy tests continue to pass.

import type { Lifecycle } from "../lifecycle.js";
import type { HookJSONOutput } from "../hook-output.js";
import type { PermissionRequestPayload } from "../types.js";
import { getPermissionPolicyLoader } from "../permissions/policy-loader.js";

export async function permissionHook(
  payload: PermissionRequestPayload,
  _toolUseID?: string,
  _options?: { signal: AbortSignal },
): Promise<HookJSONOutput> {
  const loader = getPermissionPolicyLoader();
  if (!loader) return {};

  await loader.refreshIfStale();

  let inputJson = "";
  try {
    inputJson = JSON.stringify(payload.input ?? {});
  } catch {
    // Cyclic / un-stringifiable input → empty string; argument_pattern
    // matching will simply fail to match and the policy will be skipped.
  }

  // Org/project context for scoped policies. We don't have a definitive
  // tenant binding in ToolContext today (Phase F.3 will add it); fall
  // back to undefined so only global rules apply for now.
  const org = (payload.ctx as { orgId?: string } | undefined)?.orgId;
  const project = (payload.ctx as { projectId?: string } | undefined)?.projectId;

  const match = loader.match({
    toolId: payload.toolId,
    inputJson,
    org,
    project,
  });
  if (!match) return {};

  // The lifecycle aggregator reads hookSpecificOutput.permissionDecision —
  // see core/lifecycle.ts ~line 238. The top-level `decision` field is the
  // SDK's coarser approve/block, which we don't use.
  return {
    hookSpecificOutput: {
      hookEventName: "permission_request",
      permissionDecision: match.decision,
      permissionDecisionReason: match.reason,
    },
  };
}

export function registerPermissionHook(lifecycle: Lifecycle): void {
  lifecycle.on("permission_request", "permission", permissionHook);
}
