// Lifecycle-telemetry hooks (cluster F).
//
// Default no-op + structured-log handlers for the 9 lifecycle points that
// were dispatched in production code but had no built-in registrar. Per
// CLAUDE.md / docs/PARITY.md these were "operator-attachable extension
// points" — the lifecycle infra (timeout, AbortController, decision
// aggregation, span instrumentation) was already wired, but a YAML
// without a matching BUILTIN_REGISTRARS entry surfaced as a `skipped`
// load result. With Phase 1B's strict-mode start gate (cluster B), any
// YAML missing a registrar fails boot loud — so the operator-attach
// pattern needed default registrars to keep the gate honest while still
// giving operators a discoverable swap point.
//
// Each handler:
//   1. Emits a single structured log line at `info` (or `warn` for the
//      failure-shaped points) bound to component `lifecycle-telemetry`
//      so Loki/Grafana can chart frequency without code changes.
//   2. Returns {} — no decision contribution, defer/deny/ask aggregation
//      is never affected.
//   3. Has zero runtime dependencies beyond getLogger (no DB, no LLM,
//      no skill loader) so the hooks load cleanly under any deps shape.
//
// To replace: swap the registrar in BUILTIN_REGISTRARS with one that
// constructs a custom handler (Langfuse session emit, OTel span event,
// Slack notification, etc.). The lifecycle.on() call shape is identical;
// the YAML keeps the same name and the operator never sees the change.

import type { Lifecycle } from "../lifecycle.js";
import type { HookJSONOutput } from "../hook-output.js";
import type {
  SessionEndPayload,
  UserPromptSubmitPayload,
  PostToolFailurePayload,
  PostToolBatchPayload,
  SubAgentStartPayload,
  SubAgentStopPayload,
  TaskCreatedPayload,
  TaskCompletedPayload,
  PostCompactPayload,
} from "../types.js";
import { getLogger } from "../../observability/logger.js";

const log = getLogger("lifecycle-telemetry");

// --- session_end ----------------------------------------------------------

export async function sessionEndHook(
  payload: SessionEndPayload,
): Promise<HookJSONOutput> {
  log.info(
    { sessionId: payload.sessionId, finishReason: payload.finishReason },
    "session_end",
  );
  return {};
}

export function registerSessionEndHook(lifecycle: Lifecycle): void {
  lifecycle.on("session_end", "session-end-telemetry", sessionEndHook);
}

// --- user_prompt_submit ---------------------------------------------------

export async function userPromptSubmitHook(
  payload: UserPromptSubmitPayload,
): Promise<HookJSONOutput> {
  // Don't log the prompt body — it routinely carries SMILES / project
  // names / experiment IDs that the centralised redactor would scrub
  // anyway. Length is enough to chart turn-size distributions.
  log.info(
    {
      sessionId: payload.sessionId,
      promptLength: payload.prompt.length,
    },
    "user_prompt_submit",
  );
  return {};
}

export function registerUserPromptSubmitHook(lifecycle: Lifecycle): void {
  lifecycle.on(
    "user_prompt_submit",
    "user-prompt-submit-telemetry",
    userPromptSubmitHook,
  );
}

// --- post_tool_failure ----------------------------------------------------

export async function postToolFailureHook(
  payload: PostToolFailurePayload,
): Promise<HookJSONOutput> {
  // err serializer in logger.ts scrubs message/stack of SMILES + compound
  // codes that Postgres/MCP drivers leak into "Failing row contains (...)".
  log.warn(
    {
      toolId: payload.toolId,
      durationMs: payload.durationMs,
      err: payload.error,
    },
    "post_tool_failure",
  );
  return {};
}

export function registerPostToolFailureHook(lifecycle: Lifecycle): void {
  lifecycle.on(
    "post_tool_failure",
    "post-tool-failure-telemetry",
    postToolFailureHook,
  );
}

// --- post_tool_batch ------------------------------------------------------

export async function postToolBatchHook(
  payload: PostToolBatchPayload,
): Promise<HookJSONOutput> {
  log.info(
    {
      batchSize: payload.batch.length,
      toolIds: payload.batch.map((e) => e.toolId),
    },
    "post_tool_batch",
  );
  return {};
}

export function registerPostToolBatchHook(lifecycle: Lifecycle): void {
  lifecycle.on(
    "post_tool_batch",
    "post-tool-batch-telemetry",
    postToolBatchHook,
  );
}

// --- subagent_start / subagent_stop --------------------------------------

export async function subagentStartHook(
  payload: SubAgentStartPayload,
): Promise<HookJSONOutput> {
  log.info(
    {
      type: payload.type,
      maxSteps: payload.taskSpec.max_steps ?? null,
      maxTokens: payload.taskSpec.max_tokens ?? null,
    },
    "subagent_start",
  );
  return {};
}

export function registerSubagentStartHook(lifecycle: Lifecycle): void {
  lifecycle.on(
    "subagent_start",
    "subagent-start-telemetry",
    subagentStartHook,
  );
}

export async function subagentStopHook(
  payload: SubAgentStopPayload,
): Promise<HookJSONOutput> {
  log.info(
    {
      type: payload.type,
      finishReason: payload.result.finishReason,
      stepsUsed: payload.result.stepsUsed,
      durationMs: payload.durationMs,
      promptTokens: payload.result.usage.promptTokens,
      completionTokens: payload.result.usage.completionTokens,
    },
    "subagent_stop",
  );
  return {};
}

export function registerSubagentStopHook(lifecycle: Lifecycle): void {
  lifecycle.on("subagent_stop", "subagent-stop-telemetry", subagentStopHook);
}

// --- task_created / task_completed ---------------------------------------

export async function taskCreatedHook(
  payload: TaskCreatedPayload,
): Promise<HookJSONOutput> {
  log.info(
    { todoId: payload.todoId, ordering: payload.ordering },
    "task_created",
  );
  return {};
}

export function registerTaskCreatedHook(lifecycle: Lifecycle): void {
  lifecycle.on("task_created", "task-created-telemetry", taskCreatedHook);
}

export async function taskCompletedHook(
  payload: TaskCompletedPayload,
): Promise<HookJSONOutput> {
  log.info({ todoId: payload.todoId }, "task_completed");
  return {};
}

export function registerTaskCompletedHook(lifecycle: Lifecycle): void {
  lifecycle.on(
    "task_completed",
    "task-completed-telemetry",
    taskCompletedHook,
  );
}

// --- post_compact ---------------------------------------------------------

export async function postCompactHook(
  payload: PostCompactPayload,
): Promise<HookJSONOutput> {
  log.info(
    {
      trigger: payload.trigger,
      preTokens: payload.pre_tokens,
      postTokens: payload.post_tokens,
      // Negative ratio guards a pathological compactor that grew the
      // window — surface it in the same field rather than silently
      // logging a positive shrink.
      shrinkRatio:
        payload.pre_tokens > 0
          ? 1 - payload.post_tokens / payload.pre_tokens
          : null,
    },
    "post_compact",
  );
  return {};
}

export function registerPostCompactHook(lifecycle: Lifecycle): void {
  lifecycle.on("post_compact", "post-compact-telemetry", postCompactHook);
}
