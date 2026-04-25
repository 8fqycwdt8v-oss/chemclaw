// Tool: propose_hypothesis (non-terminal).
//
// Transactional INSERT into hypotheses + hypothesis_citations + emission
// of `hypothesis_proposed` into ingestion_events. Anti-fabrication guard:
// rejects with 400-style Error if any cited_fact_id is not in the
// caller's per-turn seenFactIds set.

import { z } from "zod";
import type { Pool } from "pg";

import { withUserContext } from "../db.js";

export const ProposeHypothesisInput = z.object({
  hypothesis_text: z.string().min(10).max(4000),
  cited_fact_ids: z.array(z.string().uuid()).min(1).max(50),
  cited_reaction_ids: z.array(z.string().uuid()).max(100).optional(),
  confidence: z.number().min(0).max(1),
  scope_nce_project_id: z.string().uuid().optional(),
  citation_notes: z.record(z.string().uuid(), z.string().max(500)).optional(),
});
export type ProposeHypothesisInput = z.infer<typeof ProposeHypothesisInput>;

export const ProposeHypothesisOutput = z.object({
  hypothesis_id: z.string().uuid(),
  confidence_tier: z.enum(["low", "medium", "high"]),
  persisted_at: z.string(),
  projection_status: z.literal("pending"),
});
export type ProposeHypothesisOutput = z.infer<typeof ProposeHypothesisOutput>;

export interface ProposeHypothesisDeps {
  pool: Pool;
  userEntraId: string;
  seenFactIds: Set<string>;
  agentTraceId?: string;
}

export async function proposeHypothesis(
  input: ProposeHypothesisInput,
  deps: ProposeHypothesisDeps,
): Promise<ProposeHypothesisOutput> {
  const parsed = ProposeHypothesisInput.parse(input);

  // Anti-fabrication guard — every cited fact_id MUST have been surfaced to
  // the agent within this turn.
  const unseen = parsed.cited_fact_ids.filter((f) => !deps.seenFactIds.has(f));
  if (unseen.length > 0) {
    throw new Error(
      `propose_hypothesis rejected: cited_fact_ids not seen in this turn: ${unseen.join(", ")}. ` +
        `Re-plan and cite fact_ids actually returned by a prior tool call.`,
    );
  }

  const result = await withUserContext(deps.pool, deps.userEntraId, async (client) => {
    const ins = await client.query(
      `INSERT INTO hypotheses (
         hypothesis_text, confidence, scope_nce_project_id,
         proposed_by_user_entra_id, agent_trace_id
       ) VALUES ($1, $2, $3::uuid, $4, $5)
       RETURNING id, confidence_tier, created_at`,
      [
        parsed.hypothesis_text,
        parsed.confidence,
        parsed.scope_nce_project_id ?? null,
        deps.userEntraId,
        deps.agentTraceId ?? null,
      ],
    );
    const hid: string = ins.rows[0].id;
    const tier: "low" | "medium" | "high" = ins.rows[0].confidence_tier;
    const createdAt: string = ins.rows[0].created_at instanceof Date
      ? ins.rows[0].created_at.toISOString()
      : String(ins.rows[0].created_at);

    for (const fid of parsed.cited_fact_ids) {
      const note = parsed.citation_notes?.[fid] ?? null;
      await client.query(
        `INSERT INTO hypothesis_citations (hypothesis_id, fact_id, citation_note)
         VALUES ($1::uuid, $2::uuid, $3)`,
        [hid, fid, note],
      );
    }

    await client.query(
      `INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
       VALUES ($1, 'hypotheses', $2::uuid, $3::jsonb)`,
      ["hypothesis_proposed", hid, JSON.stringify({ hypothesis_id: hid })],
    );

    return { hypothesis_id: hid, confidence_tier: tier, persisted_at: createdAt };
  });

  return ProposeHypothesisOutput.parse({
    ...result,
    projection_status: "pending",
  });
}
