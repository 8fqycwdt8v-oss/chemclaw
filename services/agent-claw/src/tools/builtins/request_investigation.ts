// request_investigation — Universal Knowledge Accumulation Phase 0 builtin.
//
// The agent calls this when it wants the (Phase 3+) interpreter to take a
// deeper look at a specific fact. In Phase 0 the queue table exists but
// the interpreter isn't deployed yet — the row sits with picked_at=NULL
// until Phase 3 lands. Wiring the builtin now keeps the agent's mental
// model stable across phases (no API churn at Phase 3 cut-over).
//
// Manual requests carry score=1.0 (max priority) and always include the
// `manual_request` reason code so the future scorer can tell agent-driven
// enqueues apart from the periodic sweep's findings. The free-text reason
// is captured verbatim (truncated to 64 chars) as a second reason_codes
// entry — useful for the human-facing audit trail without bloating the
// indexed array.
//
// Single write inside one withUserContext transaction:
//   INSERT INTO investigation_queue (fact_id, project_id, score,
//                                     reason_codes)
//
// The RLS chemclaw_app INSERT policy (db/init/68_facts_app_write_policies.sql)
// pins score=1.0 AND requires 'manual_request' ∈ reason_codes, so any
// attempt to bypass either invariant from app-role code is denied at the
// DB layer rather than relying on this client to behave.
//
// Closest analog: services/agent-claw/src/tools/builtins/promote_to_kg.ts
// (Task 11) — same withUserContext shape, same defineTool signature.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";

// ---------- Schemas ---------------------------------------------------------

export const RequestInvestigationIn = z.object({
  fact_id: z
    .string()
    .uuid()
    .describe("Fact UUID to investigate; must exist in the facts table."),
  reason: z
    .string()
    .min(3)
    .max(500)
    .describe(
      "Free-text rationale for the deep-dive. Truncated to 64 chars and " +
        "stored as a second reason_codes entry; full text not persisted.",
    ),
});
export type RequestInvestigationInput = z.infer<typeof RequestInvestigationIn>;

export const RequestInvestigationOut = z.object({
  ok: z.literal(true),
  queue_id: z.string().uuid(),
});
export type RequestInvestigationOutput = z.infer<typeof RequestInvestigationOut>;

// ---------- Factory ---------------------------------------------------------

export function buildRequestInvestigationTool(pool: Pool) {
  return defineTool({
    id: "request_investigation",
    description:
      "Request a manual deep-dive investigation on a specific fact. " +
      "Enqueues a high-priority row in investigation_queue (score=1.0, " +
      "reason_codes=['manual_request', <truncated reason>]); the " +
      "interpreter (Phase 3+) picks it up on the next sweep. The row sits " +
      "with picked_at=NULL until Phase 3 deploys.",
    inputSchema: RequestInvestigationIn,
    outputSchema: RequestInvestigationOut,
    annotations: { readOnly: false },

    execute: async (ctx, input) => {
      // Truncated reason becomes the second reason_codes entry. Keep the
      // 64-char cap aligned with the comment above; bumping the limit
      // means a wider GIN/BTREE on reason_codes downstream.
      const reasonTrunc = input.reason.slice(0, 64);

      return await withUserContext(pool, ctx.userEntraId, async (client) => {
        const r = await client.query<{ id: string }>(
          `INSERT INTO investigation_queue
             (fact_id, project_id, score, reason_codes)
           VALUES ($1::uuid, $2::uuid, $3, $4::text[])
           RETURNING id`,
          [
            input.fact_id,
            ctx.nceProjectId,
            1.0,
            ["manual_request", reasonTrunc],
          ],
        );

        const row = r.rows[0];
        if (!row) {
          throw new Error(
            "request_investigation: INSERT INTO investigation_queue did not RETURN a row",
          );
        }

        return RequestInvestigationOut.parse({
          ok: true as const,
          queue_id: row.id,
        });
      });
    },
  });
}
