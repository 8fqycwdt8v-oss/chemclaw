// promote_workflow_to_tool — forge a reusable agent tool from a finished workflow.
//
// Stores a skill_library row (kind='forged_tool') whose body references the
// captured workflow_id + version. Future sessions can call the forged tool
// by name; the LLM doesn't need to reconstruct the JSON DSL.
//
// SECURITY: scope='global' or scope='org' requires global_admin / org_admin
// because once promoted the tool is callable by every user in that scope.
// Private scope (default) is open to any agent caller.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { withSystemContext } from "../../db/with-user-context.js";
import { isAdmin } from "../../middleware/require-admin.js";
import { appendAudit } from "../../routes/admin/audit-log.js";
import { getLogger } from "../../observability/logger.js";

const log = getLogger("promote_workflow_to_tool");

export const PromoteWorkflowToToolIn = z.object({
  workflow_id: z.string().uuid(),
  tool_name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/, {
    message: "tool_name must be snake_case (lowercase, digits, underscores)",
  }),
  description: z.string().min(10).max(2000),
  scope: z.enum(["private", "project", "org", "global"]).default("private"),
  scope_id: z.string().optional().describe(
    "Required when scope='project' or 'org'. The project_id or org_id the " +
      "promoted tool is scoped to.",
  ),
});
export type PromoteWorkflowToToolInput = z.infer<typeof PromoteWorkflowToToolIn>;

export const PromoteWorkflowToToolOut = z.object({
  tool_name: z.string(),
  workflow_id: z.string(),
  workflow_version: z.number(),
  scope: z.string(),
  promoted: z.boolean(),
});
export type PromoteWorkflowToToolOutput = z.infer<typeof PromoteWorkflowToToolOut>;

export function buildPromoteWorkflowToToolTool(pool: Pool) {
  return defineTool({
    id: "promote_workflow_to_tool",
    description:
      "Forge a reusable agent tool from a workflow. Once promoted, the tool " +
      "is callable by name in future sessions and dispatches workflow_run on " +
      "the captured workflow_id + version. scope='private' (default) is open " +
      "to any caller; scope='project'/'org'/'global' require admin role at " +
      "that level (audited).",
    inputSchema: PromoteWorkflowToToolIn,
    outputSchema: PromoteWorkflowToToolOut,
    annotations: { readOnly: false },
    execute: async (ctx, input) => {
      const actor = ctx.userEntraId ?? "__agent__";
      const scope = input.scope ?? "private";

      // Admin gate. Private scope is always allowed; project / org / global
      // require an explicit admin grant. Empty userEntraId (sub-agent /
      // synthetic call) is rejected for non-private scopes.
      if (scope !== "private") {
        if (!ctx.userEntraId) {
          throw new Error("non-private scope requires a real user identity");
        }
        if (scope === "global") {
          const ok = await isAdmin(pool, actor, "global_admin", "");
          if (!ok) throw new Error("scope='global' requires global_admin role");
        } else if (scope === "org") {
          if (!input.scope_id) throw new Error("scope='org' requires scope_id");
          const ok = await isAdmin(pool, actor, "org_admin", input.scope_id);
          if (!ok) throw new Error(`scope='org' requires org_admin role for org ${input.scope_id}`);
        } else if (scope === "project") {
          if (!input.scope_id) throw new Error("scope='project' requires scope_id");
          const ok = await isAdmin(pool, actor, "project_admin", input.scope_id);
          if (!ok) throw new Error(`scope='project' requires project_admin role for project ${input.scope_id}`);
        }
      }

      const created = await withSystemContext(pool, async (client) => {
        const ver = await client.query<{ version: number }>(
          `SELECT version FROM workflows WHERE id = $1::uuid`,
          [input.workflow_id],
        );
        if (ver.rowCount === 0) {
          throw new Error(`workflow not found: ${input.workflow_id}`);
        }
        const version = ver.rows[0]!.version;
        // Forged tools live in skill_library with kind='forged_tool'. The
        // prompt_md field carries the workflow reference as JSON so the
        // harness's forged-tool dispatcher can materialize it as a
        // workflow_run call at execution time.
        const body = JSON.stringify({
          kind: "workflow",
          workflow_id: input.workflow_id,
          workflow_version: version,
          description: input.description,
          scope,
          scope_id: input.scope_id ?? null,
        });
        await client.query(
          `INSERT INTO skill_library
              (name, prompt_md, kind, proposed_by_user_entra_id, active, version)
           VALUES ($1, $2, 'forged_tool', $3, FALSE, 1)
           ON CONFLICT (name, version) DO UPDATE
              SET prompt_md = EXCLUDED.prompt_md,
                  updated_at = NOW()`,
          [input.tool_name, body, actor],
        );
        return { version };
      });

      await appendAudit(pool, {
        actor,
        action: "workflow.promote_to_tool",
        target: input.tool_name,
        afterValue: {
          workflow_id: input.workflow_id,
          workflow_version: created.version,
          scope,
          scope_id: input.scope_id ?? null,
        },
      }).catch(() => undefined);

      log.info(
        {
          event: "workflow_promoted_to_tool",
          tool_name: input.tool_name,
          workflow_id: input.workflow_id,
          scope,
        },
        "workflow promoted to forged tool",
      );
      return {
        tool_name: input.tool_name,
        workflow_id: input.workflow_id,
        workflow_version: created.version,
        scope,
        promoted: true,
      };
    },
  });
}
