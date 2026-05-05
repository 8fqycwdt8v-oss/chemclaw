// add_forged_tool_test — append a persistent test case to a forged tool.
//
// Inserts a row in forged_tool_tests. RLS-scoped: the caller must own the
// skill_library row (same proposed_by_user_entra_id).
//
// Input: forged_tool_id, input_json, expected_output_json, optional tolerance_json,
//        optional kind (functional | contract | property).
//
// Returns: the newly inserted test case id.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const AddForgedToolTestIn = z.object({
  forged_tool_id: z.string().uuid("forged_tool_id must be a valid UUID"),
  // z.record() already rejects null at parse time with a clear error;
  // an additional .refine(v !== null) was redundant and tripped no-unnecessary-condition.
  input_json: z.record(z.unknown()),
  expected_output_json: z.record(z.unknown()),
  tolerance_json: z.record(z.number().nonnegative()).optional(),
  kind: z.enum(["functional", "contract", "property"]).optional().default("functional"),
});
export type AddForgedToolTestInput = z.infer<typeof AddForgedToolTestIn>;

export const AddForgedToolTestOut = z.object({
  test_id: z.string().uuid(),
  forged_tool_id: z.string().uuid(),
  kind: z.string(),
});
export type AddForgedToolTestOutput = z.infer<typeof AddForgedToolTestOut>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildAddForgedToolTestTool(pool: Pool, userEntraId: string) {
  return defineTool({
    id: "add_forged_tool_test",
    description:
      "Append a persistent test case to an existing forged tool in forged_tool_tests. " +
      "Only the tool's owner can add tests. " +
      "kind must be one of: functional (default), contract, property.",
    inputSchema: AddForgedToolTestIn,
    outputSchema: AddForgedToolTestOut,
    annotations: { readOnly: false },

    execute: async (_ctx, input) => {
      // Verify tool ownership via RLS-aware query.
      const { rows: ownerRows } = await pool.query<{ id: string }>(
        `SELECT id::text
           FROM skill_library
          WHERE id = $1::uuid
            AND kind = 'forged_tool'
            AND proposed_by_user_entra_id = $2`,
        [input.forged_tool_id, userEntraId],
      );

      if (ownerRows.length === 0) {
        throw new Error(
          `add_forged_tool_test: tool '${input.forged_tool_id}' not found or you are not the owner.`,
        );
      }

      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO forged_tool_tests
           (forged_tool_id, input_json, expected_output_json, tolerance_json, kind)
         VALUES ($1::uuid, $2::jsonb, $3::jsonb, $4::jsonb, $5)
         RETURNING id::text`,
        [
          input.forged_tool_id,
          JSON.stringify(input.input_json),
          JSON.stringify(input.expected_output_json),
          input.tolerance_json ? JSON.stringify(input.tolerance_json) : null,
          input.kind,
        ],
      );

      const testId = rows[0]?.id;
      if (!testId) {
        throw new Error("add_forged_tool_test: insert did not return an id.");
      }

      return {
        test_id: testId,
        forged_tool_id: input.forged_tool_id,
        kind: input.kind ?? "functional",
      };
    },
  });
}
