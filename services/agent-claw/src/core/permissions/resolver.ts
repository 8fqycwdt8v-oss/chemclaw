// Phase 6: Permission resolver.
//
// Translates the static rule layer (permissionMode + allowedTools /
// disallowedTools) plus the dynamic hook + callback chain into a single
// PermissionResolution that step.ts honours BEFORE pre_tool dispatch.
//
// Order of precedence:
//   1. permissionMode === "bypassPermissions" → always allow.
//   2. disallowedTools matches → deny (wins over allowedTools).
//   3. allowedTools matches → allow.
//   4. permissionMode === "acceptEdits" + tool is filesystem-touching → allow.
//   5. permissionMode === "plan" → defer.
//   6. permissionMode === "dontAsk" → deny.
//   7. permissionMode === "default" → fire permission_request hook; if hook
//      returns a decision, honour it. Otherwise call permissionCallback (if
//      set). Otherwise deny.
//
// Interaction with pre_tool hooks: the resolver runs FIRST. If it returns
// allow or ask, step.ts proceeds to dispatch pre_tool, which may downgrade
// to deny. If it returns deny or defer, step.ts short-circuits.

import type { Lifecycle } from "../lifecycle.js";
import type { Tool } from "../../tools/tool.js";
import type {
  PermissionOptions,
  PermissionResolution,
  ToolContext,
} from "../types.js";

export interface ResolveDecisionInput {
  tool: Tool;
  input: unknown;
  ctx: ToolContext;
  options: PermissionOptions | undefined;
  lifecycle: Lifecycle;
}

export interface ResolveDecisionResult {
  decision: PermissionResolution;
  reason?: string;
}

// Tool ids treated as filesystem-touching for the acceptEdits short-circuit.
// Conservative: only tools that actually write to disk / execute code that
// could write to disk are listed. Read-only filesystem reads (none in the
// chemclaw catalog today) would not belong here.
const FILESYSTEM_TOUCHING_TOOL_IDS: ReadonlySet<string> = new Set([
  "run_program", // E2B sandbox can write within /sandbox during the run.
  // SDK-shape tool ids retained for parity tests / external callers.
  "Write",
  "Edit",
  "MultiEdit",
]);

function isFilesystemTouchingTool(tool: Tool): boolean {
  return FILESYSTEM_TOUCHING_TOOL_IDS.has(tool.id);
}

function matchesAny(toolId: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p === toolId) return true;
    // Trailing-wildcard support (e.g. "mcp__github__*").
    if (p.endsWith("*") && toolId.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

export async function resolveDecision(
  input: ResolveDecisionInput,
): Promise<ResolveDecisionResult> {
  const { tool, options } = input;
  const mode = options?.permissionMode ?? "default";

  if (mode === "bypassPermissions") {
    return { decision: "allow", reason: "bypassPermissions mode" };
  }

  // disallowedTools wins over allowedTools.
  if (matchesAny(tool.id, options?.disallowedTools ?? [])) {
    return { decision: "deny", reason: `tool ${tool.id} in disallowedTools` };
  }

  if (matchesAny(tool.id, options?.allowedTools ?? [])) {
    return { decision: "allow", reason: `tool ${tool.id} in allowedTools` };
  }

  if (mode === "acceptEdits" && isFilesystemTouchingTool(tool)) {
    return {
      decision: "allow",
      reason: "acceptEdits mode (filesystem tool auto-approved)",
    };
  }

  if (mode === "plan") {
    return {
      decision: "defer",
      reason: "plan mode (route should emit plan instead of executing)",
    };
  }

  if (mode === "dontAsk") {
    return {
      decision: "deny",
      reason: "dontAsk mode and no allowedTools match",
    };
  }

  // default mode — try the permission_request hook chain first.
  const hookResult = await input.lifecycle.dispatch("permission_request", {
    ctx: input.ctx,
    toolId: tool.id,
    input: input.input,
  });

  if (hookResult.decision) {
    // Lifecycle.dispatch already aggregated via deny>defer>ask>allow.
    return {
      decision: hookResult.decision,
      reason: hookResult.reason,
    };
  }

  // No hook decision — try the explicit callback.
  if (options?.permissionCallback) {
    const cbResult = await options.permissionCallback({
      toolId: tool.id,
      input: input.input,
      ctx: input.ctx,
    });
    return { decision: cbResult, reason: "permissionCallback" };
  }

  return { decision: "deny", reason: "no allow rule and no callback" };
}
