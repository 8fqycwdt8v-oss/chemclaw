// propose_hypothesis — Phase B.2 builtin.
//
// Transactional INSERT into hypotheses + hypothesis_citations + emission of
// `hypothesis_proposed` ingestion event. Anti-fabrication HARD GUARD:
// every cited_fact_id MUST be in ctx.scratchpad.seenFactIds; if any are
// absent the tool throws so the agent re-plans.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";

// ---------- Schemas ----------------------------------------------------------

export const ProposeHypothesisIn = z.object({
  hypothesis_text: z.string().min(10).max(4000),
  cited_fact_ids: z.array(z.string().uuid()).min(1).max(50),
  cited_reaction_ids: z.array(z.string().uuid()).max(100).optional(),
  confidence: z.number().min(0).max(1),
  scope_nce_project_id: z.string().uuid().optional(),
  citation_notes: z.record(z.string().uuid(), z.string().max(500)).optional(),
});
export type ProposeHypothesisInput = z.infer<typeof ProposeHypothesisIn>;

export const ProposeHypothesisOut = z.object({
  hypothesis_id: z.string().uuid(),
  confidence_tier: z.enum(["low", "medium", "high"]),
  persisted_at: z.string(),
  projection_status: z.literal("pending"),
});
export type ProposeHypothesisOutput = z.infer<typeof ProposeHypothesisOut>;

// ---------- Factory ----------------------------------------------------------

export function buildProposeHypothesisTool(pool: Pool, agentTraceId?: string) {
  return defineTool({
    id: "propose_hypothesis",
    description:
      "Persist a hypothesis backed by cited fact_ids already surfaced this turn. " +
      "Rejects with an error if any cited_fact_id has not been seen in a prior tool call " +
      "(anti-fabrication hard guard). Emits hypothesis_proposed ingestion event.",
    inputSchema: ProposeHypothesisIn,
    outputSchema: ProposeHypothesisOut,

    execute: async (ctx, input) => {
      // ── Anti-fabrication HARD GUARD ────────────────────────────────────────
      const seen =
        (ctx.scratchpad.get("seenFactIds") as Set<string> | undefined) ??
        new Set<string>();

      const unseen = input.cited_fact_ids.filter((f) => !seen.has(f));
      if (unseen.length > 0) {
        throw new Error(
          `propose_hypothesis rejected: cited_fact_ids not seen in this turn: ${unseen.join(", ")}. ` +
            `Re-plan and cite fact_ids actually returned by a prior tool call.`,
        );
      }

      // ── Transactional INSERT ───────────────────────────────────────────────
      const result = await withUserContext(pool, ctx.userEntraId, async (client) => {
        const ins = await client.query(
          `INSERT INTO hypotheses (
             hypothesis_text, confidence, scope_nce_project_id,
             proposed_by_user_entra_id, agent_trace_id
           ) VALUES ($1, $2, $3::uuid, $4, $5)
           RETURNING id, confidence_tier, created_at`,
          [
            input.hypothesis_text,
            input.confidence,
            input.scope_nce_project_id ?? null,
            ctx.userEntraId,
            agentTraceId ?? null,
          ],
        );

        const hid: string = ins.rows[0].id;
        const tier: "low" | "medium" | "high" = ins.rows[0].confidence_tier;
        // Narrow the `any`-typed row column through a typed local so the
        // .toISOString() call below is safe per @typescript-eslint/no-unsafe-call.
        const rawCreatedAt: unknown = ins.rows[0].created_at;
        const createdAt: string =
          rawCreatedAt instanceof Date
            ? rawCreatedAt.toISOString()
            : String(rawCreatedAt);

        for (const fid of input.cited_fact_ids) {
          const note = input.citation_notes?.[fid] ?? null;
          await client.query(
            `INSERT INTO hypothesis_citations (hypothesis_id, fact_id, citation_note)
             VALUES ($1::uuid, $2::uuid, $3)`,
            [hid, fid, note],
          );
        }

        await client.query(
          `INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
           VALUES ($1, 'hypotheses', $2::uuid, $3::jsonb)`,
          [
            "hypothesis_proposed",
            hid,
            JSON.stringify({ hypothesis_id: hid }),
          ],
        );

        return { hypothesis_id: hid, confidence_tier: tier, persisted_at: createdAt };
      });

      return ProposeHypothesisOut.parse({
        ...result,
        projection_status: "pending",
      });
    },
  });
}
