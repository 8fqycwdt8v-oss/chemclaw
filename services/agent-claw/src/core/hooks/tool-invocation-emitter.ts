// services/agent-claw/src/core/hooks/tool-invocation-emitter.ts
//
// Phase 0 — Universal Knowledge Accumulation post-tool extraction surface.
//
// Fires on every tool call (success or failure) when the feature flag
// `kg.auto_extraction.enabled` resolves to true for the current
// (user, project) context. Emits ONE `tool_invocation_complete` ingestion
// event per call, carrying the redacted args + redacted result + metadata
// (tool name, duration, ok flag, error string). The `tool_result_extractor`
// projector (Task 9) consumes these events and dispatches to the per-source
// extractor module declared in `extraction_registry`.
//
// Phase 1.0b plumbed the harness's real post_tool / post_tool_failure
// envelope through to this hook. It reads:
//   - toolId               from PostToolPayload.toolId
//   - ctx.userEntraId      from PostToolPayload.ctx
//   - ctx.nceProjectId     from PostToolPayload.ctx
//   - invocationId         from PostToolPayload.invocationId (uuid, stable
//                          across success / failure for the same call)
//   - durationMs           from PostToolPayload.durationMs
//   - input / output       from PostToolPayload.input / .output (these are
//                          already redaction-passed by the upstream
//                          redact-tool-output post_tool hook AND the egress
//                          LiteLLM redactor — defense-in-depth)
//
// Internal / agent-state builtins (manage_todos, ask_user,
// dispatch_sub_agent, manage_plan) are short-circuited via the
// `tool.is_internal` flag on the registered Tool. The registry lookup
// degrades gracefully — an unregistered tool id (legacy / forged tool not
// yet hot-loaded) is treated as is_internal=false so we err on the side of
// emitting rather than silently dropping.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Lifecycle } from "../lifecycle.js";
import type { HookJSONOutput } from "../hook-output.js";
import type {
  PostToolPayload,
  PostToolFailurePayload,
} from "../types.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { getLogger } from "../../observability/logger.js";

export interface ToolInvocationEmitterDeps {
  pool: Pool;
  /** Tool registry for is_internal / result_schema_id lookups. */
  registry: ToolRegistry;
  isFeatureEnabled: (
    key: string,
    ctx: { user: string; project: string | null },
  ) => Promise<boolean>;
}

const FEATURE_FLAG_KEY = "kg.auto_extraction.enabled";

/**
 * Register the tool-invocation-emitter hook into a Lifecycle instance.
 *
 * Attaches to both `post_tool` and `post_tool_failure` so the downstream
 * projector receives one row per logical tool invocation regardless of
 * outcome. Errors are swallowed and logged at warn level — the hook must
 * never fail the agent turn.
 */
export function registerToolInvocationEmitterHook(
  lifecycle: Lifecycle,
  deps: ToolInvocationEmitterDeps,
): void {
  const log = getLogger("tool-invocation-emitter");

  async function emit(
    payload: PostToolPayload | PostToolFailurePayload,
    ok: boolean,
    output: unknown,
    error: string | null,
  ): Promise<HookJSONOutput> {
    try {
      const { ctx, toolId, input, durationMs, invocationId } = payload;

      // Defensive: skip if the envelope looks malformed. The lifecycle
      // dispatcher forwards `unknown` at the boundary, so even though the
      // typed dispatch insists on PostToolPayload we re-check here to
      // tolerate hand-crafted dispatches (tests, future call sites) that
      // omit fields. The hook must never crash the turn.
      if (typeof toolId !== "string" || toolId.length === 0) return {};

      // Skip internal agent-state builtins (manage_todos, ask_user,
      // dispatch_sub_agent, manage_plan). The registry lookup may miss
      // (forged tools not yet hot-loaded, legacy tool ids); fall back to
      // is_internal=false in that case so we err on the side of emitting.
      const tool = deps.registry.get(toolId);
      if (tool?.is_internal === true) return {};

      // Feature-flag gate. Default-off until an admin enables KG auto
      // extraction for the org / project (Task 6 seeded the flag with
      // enabled=false).
      const enabled = await deps.isFeatureEnabled(FEATURE_FLAG_KEY, {
        user: ctx.userEntraId,
        project: ctx.nceProjectId ?? null,
      });
      if (!enabled) return {};

      // Fall back to a fresh UUID if a non-production dispatch site forgot
      // to thread invocationId through. The real run-one-tool.ts path
      // always populates it.
      const eventInvocationId = invocationId ?? randomUUID();
      const resultSchemaId = tool?.result_schema_id ?? null;

      await deps.pool.query(
        `INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
         VALUES ('tool_invocation_complete', 'tool_invocations', $1::uuid,
                 jsonb_build_object(
                   'tool_name', $2::text,
                   'user_entra_id', $3::text,
                   'project_id', $4::uuid,
                   'args', $5::jsonb,
                   'result', $6::jsonb,
                   'result_schema_id', $7::text,
                   'duration_ms', $8::int,
                   'ok', $9::boolean,
                   'error', $10::text
                 ))`,
        [
          eventInvocationId,
          toolId,
          ctx.userEntraId,
          ctx.nceProjectId,
          // Defense-in-depth: input / output are the post-redaction values
          // produced by the upstream redact-tool-output hook + the egress
          // redactor. `JSON.stringify(undefined)` returns undefined, so
          // coalesce to null to keep the JSONB cast happy.
          JSON.stringify(input ?? null),
          JSON.stringify(output ?? null),
          resultSchemaId,
          durationMs ?? 0,
          ok,
          error,
        ],
      );
    } catch (err) {
      // The hook must never fail the agent turn — log + swallow.
      log.warn(
        { err, toolId: payload.toolId },
        "tool-invocation-emitter failed",
      );
    }
    return {};
  }

  lifecycle.on(
    "post_tool",
    "tool-invocation-emitter",
    async (payload, _toolUseId, _opts) => {
      return await emit(payload, true, payload.output, null);
    },
  );
  lifecycle.on(
    "post_tool_failure",
    "tool-invocation-emitter",
    async (payload, _toolUseId, _opts) => {
      return await emit(payload, false, null, payload.error.message);
    },
  );
}
