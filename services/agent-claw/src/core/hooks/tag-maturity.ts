// post_tool hook: tag-maturity
//
// Stamps a `maturity: "EXPLORATORY"` field on tool output objects.
// No-op for primitives, arrays, and null.
//
// Phase C: also writes a row into `artifacts` for any structured tool output
// (citation list, hypothesis dict, sub-agent result, etc.) and records the
// artifact ID + maturity in ctx.scratchpad.artifactMaturity so the
// foundation-citation-guard pre_tool hook can check tiers on the next call.

import type { Pool } from "pg";
import type { PostToolPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";

// Tools whose output carries structured data worth persisting as an artifact.
// All other tool outputs are stamped but NOT persisted (keep artifact table lean).
const ARTIFACT_TOOL_IDS = new Set<string>([
  "propose_hypothesis",
  "synthesize_insights",
  "draft_section",
  "mark_research_done",
  "dispatch_sub_agent",
  "check_contradictions",
  "compute_confidence_ensemble",
]);

/**
 * Stamp maturity on an output value.
 * Returns the (possibly mutated) value.
 */
export function stampMaturity(output: unknown): unknown {
  if (
    output !== null &&
    typeof output === "object" &&
    !Array.isArray(output)
  ) {
    const obj = output as Record<string, unknown>;
    if (!("maturity" in obj)) {
      obj["maturity"] = "EXPLORATORY";
    }
    return obj;
  }
  return output;
}

/**
 * Determine the maturity tier for a tool output.
 * Phase C: always EXPLORATORY at first stamp. Promotion happens via the
 * POST /api/artifacts/:id/maturity endpoint.
 */
export function resolveMaturity(output: unknown): "EXPLORATORY" | "WORKING" | "FOUNDATION" {
  if (
    output !== null &&
    typeof output === "object" &&
    !Array.isArray(output)
  ) {
    const tier = (output as Record<string, unknown>)["maturity"];
    if (tier === "WORKING" || tier === "FOUNDATION") return tier;
  }
  return "EXPLORATORY";
}

/**
 * post_tool handler: stamps maturity on payload.output in-place.
 * Phase C: also persists artifact rows (if pool provided) and updates
 * ctx.scratchpad.artifactMaturity for downstream guard hooks.
 */
export async function tagMaturityHook(
  payload: PostToolPayload,
  pool?: Pool,
): Promise<void> {
  (payload as { output: unknown }).output = stampMaturity(payload.output);

  const output = payload.output;
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return; // only persist structured outputs
  }

  const maturity = resolveMaturity(output);

  // Ensure the artifactMaturity scratchpad map exists.
  let maturityMap = payload.ctx.scratchpad.get("artifactMaturity") as
    | Map<string, string>
    | undefined;
  if (!maturityMap) {
    maturityMap = new Map<string, string>();
    payload.ctx.scratchpad.set("artifactMaturity", maturityMap);
  }

  // If this is a tool whose output should be persisted as an artifact, do so.
  if (pool && ARTIFACT_TOOL_IDS.has(payload.toolId)) {
    try {
      const { withUserContext } = await import("../../db/with-user-context.js");
      await withUserContext(pool, payload.ctx.userEntraId, async (client) => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO artifacts (kind, payload, owner_entra_id, maturity, tool_id)
           VALUES ($1, $2::jsonb, $3, $4, $5)
           RETURNING id::text AS id`,
          [
            payload.toolId,
            JSON.stringify(output),
            payload.ctx.userEntraId,
            maturity,
            payload.toolId,
          ],
        );
        const artifactId = result.rows[0]?.id;
        if (artifactId) {
          maturityMap!.set(artifactId, maturity);
          // Also stamp the artifact_id onto the output so the agent can reference it.
          (output as Record<string, unknown>)["artifact_id"] = artifactId;
        }
      });
    } catch {
      // Non-fatal: stamping still works, just no DB persistence.
    }
  }

  // For outputs that carry their own IDs (fact_id, hypothesis_id, etc.),
  // also record those IDs in the maturity map.
  const obj = output as Record<string, unknown>;
  for (const key of ["fact_id", "hypothesis_id", "report_id"]) {
    const id = obj[key];
    if (typeof id === "string" && id.length > 0) {
      maturityMap.set(id, maturity);
    }
  }
}

/**
 * Register the tag-maturity hook into a Lifecycle instance.
 * @param pool  Optional pool — if provided, artifact rows are written for
 *              structured tool outputs (ARTIFACT_TOOL_IDS).
 */
export function registerTagMaturityHook(lifecycle: Lifecycle, pool?: Pool): void {
  lifecycle.on("post_tool", "tag-maturity", (payload) => tagMaturityHook(payload, pool));
}
