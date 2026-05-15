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
// Task 7 ships the hook and its YAML descriptor but does NOT wire it into
// `core/hook-loader.ts` — Task 8 adds the BUILTIN_REGISTRARS entry and
// bumps MIN_EXPECTED_HOOKS. Until then the YAML is dormant: the loader
// skips it via the `condition` block (default false until an admin flips
// `kg.auto_extraction.enabled`).
//
// Defense-in-depth: the hook reads ONLY from `redacted_args` /
// `redacted_result`, never from any raw_* field. Callers MUST pre-redact
// via the existing agent-claw redaction stack before invoking
// lifecycle.dispatch. The unit test
// `tests/unit/hooks/tool-invocation-emitter.test.ts` asserts that a
// `raw_args` field in the input is never serialised into the SQL bind
// parameters.
//
// Lifecycle wiring: the registrar attaches to BOTH `post_tool` and
// `post_tool_failure` so the projector sees one event per logical
// invocation regardless of outcome. The YAML descriptor declares
// `lifecycle: post_tool` (single-string form to satisfy the existing
// loader schema); the registrar fans out to the failure point itself.

import type { Pool } from "pg";
import type { Lifecycle } from "../lifecycle.js";
import type { HookJSONOutput } from "../hook-output.js";
import { getLogger } from "../../observability/logger.js";

/**
 * The envelope the hook expects. Task 8 will plumb the harness to build
 * this on dispatch; until then the hook accepts whatever the lifecycle
 * forwards and structural-tests each field at runtime (no Zod parse —
 * the hook must be cheap and non-throwing).
 */
export interface ToolInvocationContext {
  user: string;
  project: string | null;
}

export interface ToolInvocationInput {
  tool: {
    name: string;
    is_internal?: boolean;
    result_schema_id?: string | null;
  };
  ctx: ToolInvocationContext;
  invocation_id: string;
  redacted_args: unknown;
  redacted_result: unknown;
  duration_ms: number;
  ok: boolean;
  error: string | null;
}

export interface ToolInvocationEmitterDeps {
  pool: Pool;
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

  async function handle(rawInput: unknown): Promise<HookJSONOutput> {
    try {
      const input = rawInput as ToolInvocationInput;

      // Defensive: skip if the envelope looks malformed. Task 8 plumbs the
      // shape; until then we tolerate missing fields rather than crash the
      // turn.
      if (!input?.tool || typeof input.tool.name !== "string") return {};

      // Short-circuit internal builtins (manage_todos, ask_user, etc.). The
      // projector has no business reasoning about agent-internal control
      // tools.
      if (input.tool.is_internal) return {};

      // Feature-flag gate. Default-off until an admin enables KG auto
      // extraction for the org / project (Task 6 seeded the flag with
      // enabled=false).
      const enabled = await deps.isFeatureEnabled(FEATURE_FLAG_KEY, input.ctx);
      if (!enabled) return {};

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
          input.invocation_id,
          input.tool.name,
          input.ctx.user,
          input.ctx.project,
          // Defense-in-depth: only the redacted_* fields ever make it into
          // the bind parameters. `JSON.stringify(undefined)` → undefined, so
          // coalesce to `null` to keep the JSONB cast happy.
          JSON.stringify(input.redacted_args ?? null),
          JSON.stringify(input.redacted_result ?? null),
          input.tool.result_schema_id ?? null,
          input.duration_ms,
          input.ok,
          input.error,
        ],
      );
    } catch (err) {
      // The hook must never fail the agent turn — log + swallow.
      const toolName =
        (rawInput as { tool?: { name?: unknown } } | undefined)?.tool?.name;
      log.warn(
        {
          err,
          tool: typeof toolName === "string" ? toolName : "<unknown>",
        },
        "tool-invocation-emitter failed",
      );
    }
    return {};
  }

  lifecycle.on(
    "post_tool",
    "tool-invocation-emitter",
    async (payload, _toolUseId, _opts) => handle(payload),
  );
  lifecycle.on(
    "post_tool_failure",
    "tool-invocation-emitter",
    async (payload, _toolUseId, _opts) => handle(payload),
  );
}
