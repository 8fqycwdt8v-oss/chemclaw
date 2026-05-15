// Phase 6: Permission resolver.
//
// STATUS: route activation complete since the 2026-05-04 baseline (PR #87).
// All six harness call sites pass `permissions: { permissionMode: "enforce" }`:
// chat.ts:405, plan.ts:115, deep-research.ts:177 and :230, sub-agent.ts:191,
// chained-harness.ts:214. Every tool dispatch consults the resolver via
// step.ts BEFORE pre_tool fires. See PARITY.md "Permission modes" row and
// ADR 010.
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
import { getLogger } from "../../observability/logger.js";
import { getPermissionPolicyLoader } from "./policy-loader.js";

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
  "run_orchestration_script", // Monty child runs LLM-authored Python; treat as write-side.
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

  if (mode === "enforce") {
    // Phase 3 of the configuration concept: consult the permission_request
    // hook (DB-backed policies). When no policy matches we used to default
    // to ALLOW, which combined with the enforce-mode-default-permissive
    // contract meant any tool with zero matching policies executed silently
    // — and an org-scoped deny that failed to thread its scope through the
    // PolicyMatchContext (orgId/projectId not yet on ToolContext) would
    // also miss, also fail open. Now: default to ASK so the UI permission
    // flow surfaces the call and sub-agent / non-interactive callers
    // (which treat ask as deny per step.ts handling) fail closed.
    //
    // Operators who legitimately want the legacy permissive default add a
    // single global allow-all policy:
    //   INSERT INTO permission_policies (scope, scope_id, decision, tool_pattern, enabled)
    //         VALUES ('global', '*', 'allow', '*', TRUE);
    const enforceResult = await input.lifecycle.dispatch("permission_request", {
      ctx: input.ctx,
      toolId: tool.id,
      input: input.input,
    });
    if (enforceResult.decision) {
      return { decision: enforceResult.decision, reason: enforceResult.reason };
    }
    // Task F — surface the case where an org-scoped policy COULD have
    // matched the tool pattern, but ctx.orgId is null (the route hasn't
    // bound a tenant identity yet). Phase F.3 will wire route-level
    // population; this WARN gives operators a Loki signal to drive that
    // work BEFORE org-scoped policies start silently failing in
    // production. Logged once per enforce-mode no-match path on a
    // tool whose pattern matches an org-scoped policy.
    if (input.ctx.orgId === null) {
      const loader = getPermissionPolicyLoader();
      if (loader) {
        const matchableOrg = loader.countMatchableOrgPolicies(tool.id);
        if (matchableOrg > 0) {
          getLogger("agent-claw.core.permissions.resolver").warn(
            {
              event: "permission_org_scoped_policy_unbound_ctx",
              tool_id: tool.id,
              policy_count: matchableOrg,
            },
            "org-scoped permission policy could match but ctx.orgId is null — route is not binding tenant identity (Phase F.3)",
          );
        }
      }
    }
    // Same surface for project-scoped policies. policy-loader.match() treats
    // ctx.project === null as a non-match for project-scoped policies, so
    // without this WARN a project-scoped deny silently fails to fire when
    // the route hasn't bound an nceProjectId.
    if (input.ctx.nceProjectId === null) {
      const loader = getPermissionPolicyLoader();
      if (loader) {
        const matchableProject = loader.countMatchableProjectPolicies(tool.id);
        if (matchableProject > 0) {
          getLogger("agent-claw.core.permissions.resolver").warn(
            {
              event: "permission_project_scoped_policy_unbound_ctx",
              tool_id: tool.id,
              policy_count: matchableProject,
            },
            "project-scoped permission policy could match but ctx.nceProjectId is null — route is not binding project identity (Phase F.3)",
          );
        }
      }
    }
    getLogger("agent-claw.core.permissions.resolver").warn(
      {
        event: "permission_enforce_no_policy_match",
        tool_id: tool.id,
      },
      "enforce-mode tool call had no matching policy; defaulting to ask",
    );
    return {
      decision: "ask",
      reason: "enforce mode: no matching policy → ask (was allow pre-fix)",
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
