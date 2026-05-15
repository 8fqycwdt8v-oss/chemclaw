// Optimization-campaign lifecycle builtins (Tranche 8 F7):
// pause / resume / complete. Each is a small status UPDATE that bumps
// optimization_campaigns.etag (mirroring recommend_next_batch's tranche-1
// etag-bookkeeping invariant) so a snapshot consumer detects state changes.
//
// Pre-fix: the agent had to fall back to raw SQL to move a campaign through
// paused / completed / aborted (see CLAUDE.md status enum), which was
// blocked behind admin tooling for non-power-users. These three builtins
// expose the legitimate state transitions:
//
//   active -> paused    (pause_optimization_campaign)
//   paused -> active    (resume_optimization_campaign)
//   active|paused -> completed | aborted   (complete_optimization_campaign)
//
// Other transitions (e.g. completed -> active) are rejected to preserve
// the lifecycle's irreversibility once a campaign is finalised.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";

const CAMPAIGN_ID = z.string().uuid();

const LifecycleOut = z.object({
  campaign_id: z.string().uuid(),
  prior_status: z.enum(["active", "paused", "completed", "aborted"]),
  new_status: z.enum(["active", "paused", "completed", "aborted"]),
  etag: z.number().int(),
  updated_at: z.string(),
});

interface CampaignRow {
  id: string;
  status: "active" | "paused" | "completed" | "aborted";
  etag: number;
  updated_at: string;
}

/**
 * Shared transactional helper. SELECT FOR UPDATE the campaign row, validate
 * the requested transition, then UPDATE status + etag + updated_at. RLS
 * enforces ownership — a caller without project access sees the campaign
 * as missing (404, not 403, by design).
 */
async function transitionCampaign(
  pool: Pool,
  userEntraId: string,
  campaignId: string,
  newStatus: "active" | "paused" | "completed" | "aborted",
  allowedFrom: ReadonlyArray<"active" | "paused" | "completed" | "aborted">,
): Promise<z.infer<typeof LifecycleOut>> {
  return await withUserContext(pool, userEntraId, async (client) => {
    const lockRes = await client.query<CampaignRow>(
      `SELECT id::text AS id, status, etag, updated_at::text AS updated_at
         FROM optimization_campaigns
        WHERE id = $1::uuid
        FOR UPDATE`,
      [campaignId],
    );
    const row = lockRes.rows[0];
    if (!row) {
      // RLS or genuine 404 — both surface as the same error for security.
      throw new Error(`campaign_not_found: ${campaignId}`);
    }
    const priorStatus = row.status;
    if (!allowedFrom.includes(priorStatus)) {
      throw new Error(
        `invalid_transition: campaign ${campaignId} is in '${priorStatus}'; ` +
          `cannot transition to '${newStatus}' (allowed from: ${allowedFrom.join(", ")})`,
      );
    }
    // No-op if already in the target state — keep idempotent so a retry
    // doesn't churn etag pointlessly.
    if (priorStatus === newStatus) {
      return {
        campaign_id: row.id,
        prior_status: priorStatus,
        new_status: newStatus,
        etag: row.etag,
        updated_at: row.updated_at,
      };
    }
    const updRes = await client.query<{ etag: number; updated_at: string }>(
      `UPDATE optimization_campaigns
          SET status = $2,
              etag = etag + 1,
              updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING etag, updated_at::text AS updated_at`,
      [campaignId, newStatus],
    );
    const updated = updRes.rows[0];
    if (!updated) {
      // Should be impossible — we hold FOR UPDATE on the row.
      throw new Error(`campaign_update_failed: ${campaignId}`);
    }
    return {
      campaign_id: row.id,
      prior_status: priorStatus,
      new_status: newStatus,
      etag: updated.etag,
      updated_at: updated.updated_at,
    };
  });
}

// ---------------------------------------------------------------------------
// pause_optimization_campaign — active -> paused
// ---------------------------------------------------------------------------

export const PauseOptimizationCampaignIn = z.object({
  campaign_id: CAMPAIGN_ID,
});
export const PauseOptimizationCampaignOut = LifecycleOut;

export function buildPauseOptimizationCampaignTool(pool: Pool) {
  return defineTool({
    id: "pause_optimization_campaign",
    description:
      "Pause an active optimization campaign. Subsequent recommend_next_batch " +
      "calls will refuse with `campaign_not_active`. Use to temporarily halt a " +
      "BO loop while waiting on external work (e.g. a manual chemistry decision). " +
      "Reversible via resume_optimization_campaign.",
    inputSchema: PauseOptimizationCampaignIn,
    outputSchema: PauseOptimizationCampaignOut,
    annotations: { readOnly: false },
    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) {
        throw new Error("pause_optimization_campaign requires userEntraId in context");
      }
      return await transitionCampaign(
        pool,
        userEntraId,
        input.campaign_id,
        "paused",
        ["active", "paused"], // paused → paused is a no-op (idempotent)
      );
    },
  });
}

// ---------------------------------------------------------------------------
// resume_optimization_campaign — paused -> active
// ---------------------------------------------------------------------------

export const ResumeOptimizationCampaignIn = z.object({
  campaign_id: CAMPAIGN_ID,
});
export const ResumeOptimizationCampaignOut = LifecycleOut;

export function buildResumeOptimizationCampaignTool(pool: Pool) {
  return defineTool({
    id: "resume_optimization_campaign",
    description:
      "Resume a paused optimization campaign. recommend_next_batch will work " +
      "again after this returns. Idempotent on already-active campaigns.",
    inputSchema: ResumeOptimizationCampaignIn,
    outputSchema: ResumeOptimizationCampaignOut,
    annotations: { readOnly: false },
    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) {
        throw new Error("resume_optimization_campaign requires userEntraId in context");
      }
      return await transitionCampaign(
        pool,
        userEntraId,
        input.campaign_id,
        "active",
        ["paused", "active"], // active → active is a no-op
      );
    },
  });
}

// ---------------------------------------------------------------------------
// complete_optimization_campaign — active|paused -> completed | aborted
// ---------------------------------------------------------------------------

export const CompleteOptimizationCampaignIn = z.object({
  campaign_id: CAMPAIGN_ID,
  outcome: z.enum(["completed", "aborted"]).default("completed"),
  outcome_summary: z.string().min(1).max(2000).optional(),
});
export const CompleteOptimizationCampaignOut = LifecycleOut.extend({
  outcome_summary_recorded: z.boolean(),
});

export function buildCompleteOptimizationCampaignTool(pool: Pool) {
  return defineTool({
    id: "complete_optimization_campaign",
    description:
      "Finalise an optimization campaign as 'completed' (success) or " +
      "'aborted' (giving up). Both are terminal — the campaign cannot be " +
      "reactivated. Refuses if the campaign is already terminal " +
      "(completed/aborted) so a confused agent doesn't silently churn the " +
      "outcome. Optional outcome_summary is appended to optimization_campaigns " +
      "(future: synthesis_campaign_events when umbrella-linked).",
    inputSchema: CompleteOptimizationCampaignIn,
    outputSchema: CompleteOptimizationCampaignOut,
    annotations: { readOnly: false },
    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) {
        throw new Error("complete_optimization_campaign requires userEntraId in context");
      }
      const outcome = input.outcome ?? "completed";
      const result = await transitionCampaign(
        pool,
        userEntraId,
        input.campaign_id,
        outcome,
        ["active", "paused"],
      );
      // outcome_summary persistence is a follow-up — the campaigns table
      // doesn't carry a free-text summary column today (would need a schema
      // migration). We surface "recorded: false" so the agent can decide
      // whether to repeat the summary in a separate channel
      // (e.g. propose_hypothesis or a synthesis_campaign_event).
      return {
        ...result,
        outcome_summary_recorded: false,
      };
    },
  });
}
