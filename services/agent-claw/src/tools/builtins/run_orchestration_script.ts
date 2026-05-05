// run_orchestration_script — code-mode tool execution via the Monty
// runtime (see services/agent-claw/src/runtime/monty/).
//
// Where this fits:
//   The standard ReAct loop emits one tool_call per LLM turn. When a task
//   needs three or more sequential read-only tools that compose data via
//   pure-Python operations (filter / sort / dedupe / join / top-k), each
//   step pays a full LLM round-trip. This builtin lets the model emit one
//   short Python script that calls the same tools as `external_function`s
//   and runs the orchestration entirely outside the LLM loop.
//
// Critical contract:
//   - allowed_tools is the script's pre-declared set of MCP / builtin tool
//     ids it intends to call. Each entry is re-validated against the
//     permission resolver at preflight; any deny short-circuits before
//     Monty starts.
//   - Every external_function call inside the script goes through the
//     standard runOneTool pipeline (permission → pre_tool → execute →
//     post_tool). The script gets the same RLS, redaction, and Langfuse
//     plumbing as if the LLM had called the tool directly.
//   - This tool is annotated readOnly: false. The script can execute
//     arbitrary Python the model wrote; it's not eligible for the parallel
//     read-only batch path.
//
// Failure semantics:
//   The builtin returns a structured result on every outcome (ok, error,
//   timeout, cancelled, child crash). The model reads `error` on the
//   next turn and adjusts. No automatic retry — that's the model's call.

import { z } from "zod";
import { defineTool } from "../tool.js";
import type { Lifecycle } from "../../core/lifecycle.js";
import type { ConfigRegistry } from "../../config/registry.js";
import type { ToolRegistry } from "../registry.js";
import { MontyHost } from "../../runtime/monty/host.js";
import {
  defaultChildFactory,
  type MontyChildFactory,
} from "../../runtime/monty/child-adapter.js";
import { loadMontyLimits } from "../../runtime/monty/limits.js";
import { getLogger } from "../../observability/logger.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const RunOrchestrationScriptIn = z.object({
  python_code: z
    .string()
    .min(1, "python_code must be non-empty")
    .max(50_000, "python_code must not exceed 50,000 characters"),
  allowed_tools: z
    .array(z.string().min(1).max(128))
    .min(1, "allowed_tools must list at least one tool id")
    .max(32, "allowed_tools may not list more than 32 ids"),
  inputs: z.record(z.unknown()).default({}),
  expected_outputs: z
    .array(z.string().min(1).max(128))
    .min(1, "expected_outputs must list at least one variable name")
    .max(50),
  reason: z.string().min(1, "reason is required for audit").max(1000),
  timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
});
export type RunOrchestrationScriptInput = z.infer<typeof RunOrchestrationScriptIn>;

const ExternalCallTrace = z.object({
  tool_id: z.string(),
  duration_ms: z.number(),
  ok: z.boolean(),
  error_message: z.string().optional(),
});

export const RunOrchestrationScriptOut = z.object({
  outputs: z.record(z.unknown()).optional(),
  stdout: z.string(),
  stderr: z.string(),
  duration_ms: z.number(),
  external_calls: z.array(ExternalCallTrace),
  error: z.string().optional(),
  /**
   * Mirrors the discriminator used by MontyHost:
   *   ok | error | timeout | cancelled | child_crashed | preflight_denied | runtime_disabled
   */
  outcome: z.enum([
    "ok",
    "error",
    "timeout",
    "cancelled",
    "child_crashed",
    "preflight_denied",
    "runtime_disabled",
  ]),
});
export type RunOrchestrationScriptOutput = z.infer<typeof RunOrchestrationScriptOut>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface RunOrchestrationScriptDeps {
  registry: ToolRegistry;
  configRegistry: ConfigRegistry;
  lifecycle: Lifecycle;
  /**
   * Optional override — tests and future in-proc bindings inject a fake
   * child factory. When undefined, we derive a SubprocessChildAdapter
   * factory from the resolved monty.binary_path at call time.
   */
  childFactoryOverride?: MontyChildFactory;
}

export function buildRunOrchestrationScriptTool(deps: RunOrchestrationScriptDeps) {
  const log = getLogger("agent-claw.tools.run_orchestration_script");

  return defineTool({
    id: "run_orchestration_script",
    description:
      "Execute a short Python script in the Monty sandbox. Use this when you would " +
      "otherwise emit 3+ sequential read-only tool calls that compose data through " +
      "pure-Python operations (filter, sort, dedupe, join, top-k). The script can " +
      "call external_function('<tool_id>', {...}) for any tool listed in allowed_tools. " +
      "Each external call goes through the standard permission + pre_tool + post_tool " +
      "pipeline. Required: reason (free text for audit). Do not use code-mode for " +
      "tools that prompt the user (ask_user), write to the DB (enqueue_batch, " +
      "workflow_*), or run generative chemistry.",
    inputSchema: RunOrchestrationScriptIn,
    outputSchema: RunOrchestrationScriptOut,
    annotations: { readOnly: false },

    execute: async (ctx, input) => {
      const startedAt = Date.now();
      const limits = await loadMontyLimits(deps.configRegistry, {
        user: ctx.userEntraId,
      });

      // Runtime gate — admins can disable code-mode globally / per-tenant.
      if (!limits.enabled) {
        return {
          outputs: undefined,
          stdout: "",
          stderr: "",
          duration_ms: Date.now() - startedAt,
          external_calls: [],
          outcome: "runtime_disabled" as const,
          error:
            "Monty runtime is disabled (set monty.enabled in config_settings to true).",
        };
      }
      if (!limits.binaryPath) {
        return {
          outputs: undefined,
          stdout: "",
          stderr: "",
          duration_ms: Date.now() - startedAt,
          external_calls: [],
          outcome: "runtime_disabled" as const,
          error:
            "Monty runtime is enabled but monty.binary_path is unset.",
        };
      }

      // Preflight 1: every entry in allowed_tools must exist in the registry.
      const dedupedAllowed = Array.from(new Set(input.allowed_tools));
      const missing: string[] = [];
      for (const id of dedupedAllowed) {
        if (!deps.registry.get(id)) missing.push(id);
      }
      if (missing.length > 0) {
        return {
          outputs: undefined,
          stdout: "",
          stderr: "",
          duration_ms: Date.now() - startedAt,
          external_calls: [],
          outcome: "preflight_denied" as const,
          error: `unknown tools in allowed_tools: ${missing.join(", ")}`,
        };
      }

      // Preflight 2: defense-in-depth — refuse interactive / state-mutating
      // tools the agent should never reach via code-mode. ask_user pauses the
      // harness, which the script can't surface; workflow_* / enqueue_batch
      // mutate state. Operators can override via permission_policies.
      const FORBIDDEN_TOOL_IDS = new Set<string>([
        "ask_user",
        "enqueue_batch",
        "workflow_define",
        "workflow_run",
        "workflow_pause_resume",
        "workflow_modify",
        "workflow_replay",
        "promote_workflow_to_tool",
        "manage_todos",
      ]);
      const forbidden = dedupedAllowed.filter((id) => FORBIDDEN_TOOL_IDS.has(id));
      if (forbidden.length > 0) {
        return {
          outputs: undefined,
          stdout: "",
          stderr: "",
          duration_ms: Date.now() - startedAt,
          external_calls: [],
          outcome: "preflight_denied" as const,
          error: `code-mode forbids these tools: ${forbidden.join(", ")}`,
        };
      }

      // We intentionally do NOT run a permission-resolver preflight for
      // each allow-listed tool. The builtin doesn't have access to the
      // outer call's `permissions` object (it's threaded through opts to
      // step.ts but not to tool.execute), so calling resolveDecision with
      // `options: undefined` would land in default mode → no callback →
      // deny for every tool, blocking even legitimate runs. Per-call
      // resolution still happens inside the bridge: runOneTool re-resolves
      // each external_function call with the same permissions snapshot the
      // outer call ran under, so policy rows still bite. If we later want
      // a true preflight, thread `permissions` through ctx (a separate
      // refactor) and re-add the check here.

      // Build the host. Per-call wall-time clamps the configured cap.
      const wallTimeMs = Math.min(
        input.timeout_ms ?? limits.wallTimeMs,
        limits.wallTimeMs,
      );

      const childFactory =
        deps.childFactoryOverride ??
        defaultChildFactory({ binaryPath: limits.binaryPath });

      const host = new MontyHost({
        childFactory,
        registry: deps.registry,
        lifecycle: deps.lifecycle,
      });

      const runId = `monty-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      log.info(
        {
          event: "monty_run_start",
          run_id: runId,
          tool_count: dedupedAllowed.length,
          wall_time_ms: wallTimeMs,
        },
        "starting Monty orchestration script",
      );

      const result = await host.run({
        runId,
        script: input.python_code,
        allowedTools: dedupedAllowed,
        inputs: input.inputs ?? {},
        expectedOutputs: input.expected_outputs,
        wallTimeMs,
        maxExternalCalls: limits.maxExternalCalls,
        ctx,
        // The builtin doesn't carry the outer `permissions` object — the
        // route's resolver already admitted us when it ran step.ts's
        // permission gate against this builtin. Inner external_function
        // calls re-run through runOneTool with options=undefined, which
        // still triggers the default-mode permission_request hook.
        permissions: undefined,
        signal: ctx.signal,
      });

      const externalCallsOut = result.externalCalls.map((c) => ({
        tool_id: c.toolId,
        duration_ms: c.durationMs,
        ok: c.ok,
        ...(c.errorMessage !== undefined ? { error_message: c.errorMessage } : {}),
      }));

      switch (result.outcome.kind) {
        case "ok":
          return {
            outputs: result.outcome.outputs,
            stdout: result.stdout,
            stderr: result.stderr,
            duration_ms: result.durationMs,
            external_calls: externalCallsOut,
            outcome: "ok" as const,
          };
        case "error":
          return {
            outputs: undefined,
            stdout: result.stdout,
            stderr:
              result.stderr +
              (result.outcome.traceback ? "\n" + result.outcome.traceback : ""),
            duration_ms: result.durationMs,
            external_calls: externalCallsOut,
            outcome: "error" as const,
            error: result.outcome.error,
          };
        case "timeout":
          return {
            outputs: undefined,
            stdout: result.stdout,
            stderr: result.stderr,
            duration_ms: result.durationMs,
            external_calls: externalCallsOut,
            outcome: "timeout" as const,
            error: `script exceeded wall time (${result.outcome.wallTimeMs} ms)`,
          };
        case "cancelled":
          return {
            outputs: undefined,
            stdout: result.stdout,
            stderr: result.stderr,
            duration_ms: result.durationMs,
            external_calls: externalCallsOut,
            outcome: "cancelled" as const,
            error: "script cancelled by upstream signal",
          };
        case "child_crashed":
          return {
            outputs: undefined,
            stdout: result.stdout,
            stderr: result.stderr,
            duration_ms: result.durationMs,
            external_calls: externalCallsOut,
            outcome: "child_crashed" as const,
            error: `Monty child crashed (exit=${String(result.outcome.exitCode)}, signal=${String(result.outcome.signal)})`,
          };
      }
    },
  });
}
