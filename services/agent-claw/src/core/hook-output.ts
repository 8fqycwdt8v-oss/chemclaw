// Phase 4A: HookJSONOutput contract.
//
// Mirrors the Claude Agent SDK HookJSONOutput shape. The lifecycle dispatcher
// reads permissionDecision and updatedInput from hookSpecificOutput; routes
// can read systemMessage / continue if needed. New hook signature is
//
//   (input, toolUseID, { signal }) => Promise<HookJSONOutput>
//
// where `signal` aborts when the hook's per-call timeout elapses (default
// 60s). Returning `{ async: true }` makes the dispatcher treat the hook as
// fire-and-forget and move on without awaiting completion.

export type PermissionDecision = "allow" | "deny" | "ask" | "defer";

export interface PreToolUseSpecificOutput {
  hookEventName: "pre_tool";
  permissionDecision?: PermissionDecision;
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
}

export interface PostToolUseSpecificOutput {
  hookEventName: "post_tool";
  additionalContext?: string;
}

export type HookSpecificOutput =
  | PreToolUseSpecificOutput
  | PostToolUseSpecificOutput
  // Forward-compat for additional hook points.
  | { hookEventName: string; [k: string]: unknown };

export type HookJSONOutput =
  // Fire-and-forget mode: dispatcher ignores the return and moves on.
  | { async: true; asyncTimeout?: number }
  | {
      continue?: boolean;
      suppressOutput?: boolean;
      stopReason?: string;
      decision?: "approve" | "block";
      systemMessage?: string;
      reason?: string;
      hookSpecificOutput?: HookSpecificOutput;
    };

export type HookCallback<P = unknown> = (
  input: P,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;

/**
 * Aggregate two decisions; deny > defer > ask > allow.
 *
 * `undefined` means "no opinion": the result is `b`. Otherwise the more
 * restrictive of the two wins. This mirrors the Claude Agent SDK's permission
 * resolution rules so that one hook returning `deny` cannot be downgraded by
 * a later hook returning `allow`.
 */
export function mostRestrictive(
  a: PermissionDecision | undefined,
  b: PermissionDecision,
): PermissionDecision {
  const order: Record<PermissionDecision, number> = {
    deny: 4,
    defer: 3,
    ask: 2,
    allow: 1,
  };
  return !a || order[b] > order[a] ? b : a;
}
