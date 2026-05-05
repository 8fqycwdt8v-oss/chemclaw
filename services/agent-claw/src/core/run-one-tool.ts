// runOneTool — extracted from step.ts so non-step callers (the Monty
// orchestration runtime, future code-mode bridges) can dispatch a single
// tool through the canonical permission → pre_tool → execute → post_tool
// pipeline without re-implementing it.
//
// Behaviour is identical to the function previously known as
// `_runOneTool` in step.ts; nothing else in the harness changed when the
// extraction landed. step.ts re-exports `StepToolOutput` for external
// consumers (none today) and now imports `runOneTool` from this module.

import type { Lifecycle } from "./lifecycle.js";
import type { PermissionOptions, ToolContext } from "./types.js";
import type { Tool } from "../tools/tool.js";
import type { StreamSink, TodoSnapshot } from "./streaming-sink.js";
import { AwaitingUserInputError } from "../tools/builtins/ask_user.js";
import { resolveDecision } from "./permissions/resolver.js";
import { withToolSpan } from "../observability/tool-spans.js";
import { getLogger } from "../observability/logger.js";

/**
 * One executed tool's contribution to a step batch — what the harness needs
 * to push onto the message history.
 */
export interface StepToolOutput {
  toolId: string;
  /** undefined if the tool was denied or otherwise skipped. */
  output: unknown;
}

export interface RunOneToolOpts {
  tools: Tool[];
  toolId: string;
  input: unknown;
  lifecycle: Lifecycle;
  ctx: ToolContext;
  streamSink?: StreamSink;
  permissions?: PermissionOptions;
  /**
   * Phase 9: true when this call is a member of a parallel read-only batch
   * (Phase 5). Set on the per-tool span as `tool.in_batch` so Langfuse can
   * group sibling tool spans in a parallel run.
   */
  inBatch?: boolean;
}

/**
 * Run one tool through the full pipeline:
 *   1. Permission resolver (when `permissions` is set).
 *   2. pre_tool dispatch.
 *   3. Input validation against the tool's Zod schema.
 *   4. Execution wrapped in withToolSpan.
 *   5. Output validation against the tool's Zod schema.
 *   6. post_tool dispatch.
 *
 * Returns the post-hook output (or a synthetic deny payload). Throws on
 * AwaitingUserInputError or any other unhandled execution error so the
 * caller can decide whether to fail the whole batch.
 */
export async function runOneTool(
  opts: RunOneToolOpts,
): Promise<StepToolOutput> {
  const { tools, toolId, input, lifecycle, ctx, streamSink, permissions } = opts;

  const tool = tools.find((t) => t.id === toolId);
  if (!tool) {
    throw new Error(
      `runOneTool: requested unknown tool "${toolId}". ` +
        `Available: [${tools.map((t) => t.id).join(", ")}]`,
    );
  }

  // ---------------------------------------------------------------------
  // Phase 6: route-level permission resolver.
  //
  // Runs BEFORE pre_tool dispatch. When permissions options are provided,
  // the resolver consults permissionMode + allowedTools / disallowedTools,
  // fires the permission_request hook (default mode), and falls back to
  // permissionCallback. A deny or defer decision short-circuits tool
  // execution with a synthetic rejection mirroring the pre_tool deny path.
  // ---------------------------------------------------------------------
  let permissionDecisionTag: "allow" | "ask" | "deny" | "defer" | "skipped" =
    "skipped";
  let permissionReasonTag: string | undefined;
  if (permissions) {
    const permResult = await resolveDecision({
      tool,
      input,
      ctx,
      options: permissions,
      lifecycle,
    });
    permissionDecisionTag = permResult.decision;
    permissionReasonTag = permResult.reason;

    if (permResult.decision === "deny" || permResult.decision === "defer") {
      const denyOutput = {
        error: `denied_by_permissions:${permResult.decision}`,
        reason: permResult.reason ?? "",
      };
      streamSink?.onToolCall?.(toolId, input);
      streamSink?.onToolResult?.(toolId, denyOutput);
      return { toolId, output: denyOutput };
    }
  }

  // pre_tool — hooks may throw to abort, mutate input via in-place writes,
  // return permissionDecision, or return updatedInput to rewrite the call.
  const prePayload = { ctx, toolId, input };
  const preResult = await lifecycle.dispatch("pre_tool", prePayload, {
    toolUseID: toolId,
    matcherTarget: toolId,
  });

  if (preResult.decision === "deny") {
    const denyOutput = {
      error: "denied_by_hook",
      reason: preResult.reason ?? "denied without reason",
    };
    streamSink?.onToolCall?.(toolId, prePayload.input);
    streamSink?.onToolResult?.(toolId, denyOutput);
    return { toolId, output: denyOutput };
  }
  if (preResult.decision === "ask" || preResult.decision === "defer") {
    getLogger("agent-claw.harness.run-one-tool").warn(
      {
        event: "permission_decision_unhandled",
        decision: preResult.decision,
        tool_id: toolId,
        reason: preResult.reason ?? "(none)",
      },
      "permission decision treated as allow (Phase 6 resolver pending)",
    );
  }

  const effectiveInput = preResult.updatedInput ?? prePayload.input;

  const parsedInput = tool.inputSchema.parse(effectiveInput);

  streamSink?.onToolCall?.(toolId, parsedInput);

  const toolStartMs = Date.now();
  let rawOutput: unknown;
  try {
    rawOutput = await withToolSpan(
      {
        toolId,
        readOnly: tool.annotations?.readOnly,
        inBatch: opts.inBatch ?? false,
        permissionDecision: permissionDecisionTag,
        permissionReason: permissionReasonTag,
      },
      () => tool.execute(ctx, parsedInput),
    );
  } catch (err) {
    if (err instanceof AwaitingUserInputError) {
      throw err;
    }
    await lifecycle.dispatch("post_tool_failure", {
      ctx,
      toolId,
      input: parsedInput,
      error: err instanceof Error ? err : new Error(String(err)),
      durationMs: Date.now() - toolStartMs,
    });
    throw err;
  }

  const parsedOutput = tool.outputSchema.parse(rawOutput);

  const postPayload = { ctx, toolId, input: effectiveInput, output: parsedOutput };
  await lifecycle.dispatch("post_tool", postPayload, {
    toolUseID: toolId,
    matcherTarget: toolId,
  });
  const effectiveOutput = postPayload.output;

  streamSink?.onToolResult?.(toolId, effectiveOutput);

  // manage_todos special-case: surface the latest checklist via
  // onTodoUpdate so the route can emit a `todo_update` SSE event.
  if (
    streamSink?.onTodoUpdate &&
    toolId === "manage_todos" &&
    effectiveOutput &&
    typeof effectiveOutput === "object" &&
    "todos" in effectiveOutput &&
    Array.isArray((effectiveOutput).todos)
  ) {
    streamSink.onTodoUpdate(
      (effectiveOutput as { todos: TodoSnapshot[] }).todos,
    );
  }

  return { toolId, output: effectiveOutput };
}
