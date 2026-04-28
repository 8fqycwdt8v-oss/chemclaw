// pre_tool hook: foundation-citation-guard — Phase C.4 (refactored Phase 4A)
//
// Rejects a tool call if:
//   - The input has `maturity_tier: "FOUNDATION"` (the caller is asserting a
//     FOUNDATION-tier claim), AND
//   - Any fact_id cited in the input appears in the harness's seenFactIds map
//     with a EXPLORATORY maturity tag.
//
// Heuristic: the hook looks at ctx.scratchpad.artifactMaturity (a Map<string, string>
// from artifact/fact ID → maturity tier). The tag-maturity post_tool hook
// populates this map when it persists artifact rows.
//
// If no artifactMaturity map is present the guard is a no-op (graceful degradation).
//
// Phase 4A change: instead of throwing to abort the tool call, the hook now
// returns a `permissionDecision: "deny"` HookJSONOutput. step.ts honours the
// deny by short-circuiting tool.execute and surfacing a synthetic rejection
// to the model, which can then choose to lower its claim or promote the
// underlying artifacts.

import type { PreToolPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";
import type { HookJSONOutput } from "../hook-output.js";

/**
 * Check if a tool input declares a FOUNDATION-tier claim while citing
 * EXPLORATORY artifacts. Returns a deny decision if so.
 */
export async function foundationCitationGuardHook(
  payload: PreToolPayload,
  _toolUseID?: string,
  _options?: { signal: AbortSignal },
): Promise<HookJSONOutput> {
  const { input, ctx } = payload;

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const obj = input as Record<string, unknown>;

  // Only fire when the caller explicitly declares FOUNDATION.
  if (obj["maturity_tier"] !== "FOUNDATION") {
    return {};
  }

  // Get the artifact maturity map from the scratchpad.
  const maturityMap = ctx.scratchpad.get("artifactMaturity") as
    | Map<string, string>
    | undefined;
  if (!maturityMap || maturityMap.size === 0) {
    return {};
  }

  // Collect cited IDs from the input.
  const citedIds: string[] = [];
  for (const key of [
    "cited_fact_ids",
    "fact_ids",
    "evidence_fact_ids",
    "source_ids",
  ]) {
    const arr = obj[key];
    if (Array.isArray(arr)) {
      for (const id of arr as unknown[]) {
        if (typeof id === "string" && id.length > 0) citedIds.push(id);
      }
    }
  }

  // Check each cited ID.
  const exploratoryCited: string[] = [];
  for (const id of citedIds) {
    const tier = maturityMap.get(id);
    if (tier === "EXPLORATORY") {
      exploratoryCited.push(id);
    }
  }

  if (exploratoryCited.length > 0) {
    const reason =
      `foundation-citation-guard: tool call declares maturity_tier='FOUNDATION' ` +
      `but cites EXPLORATORY artifact(s): ${exploratoryCited.join(", ")}. ` +
      `Promote artifact maturity before asserting FOUNDATION-tier claims, ` +
      `or lower the claim to WORKING or EXPLORATORY.`;
    return {
      hookSpecificOutput: {
        hookEventName: "pre_tool",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  }
  return {};
}

/**
 * Register the foundation-citation-guard hook into a Lifecycle instance.
 */
export function registerFoundationCitationGuardHook(lifecycle: Lifecycle): void {
  lifecycle.on(
    "pre_tool",
    "foundation-citation-guard",
    foundationCitationGuardHook,
  );
}
