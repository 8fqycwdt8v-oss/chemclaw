// kick_workflow_and_wait — convenience composite of workflow_run + poll
// until terminal. Replaces the common "start a run → poll workflow_inspect
// every few seconds → return the final output" pattern that otherwise
// burns 5+ ReAct turns per run.
//
// The agent still has access to the underlying workflow_run +
// workflow_inspect builtins for cases where it wants to defer the wait
// (e.g. a long-running QM batch where the agent will go do something
// else in parallel). This shorthand is for the synchronous case where
// the agent wants the result before the next reasoning step.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { inspectRun, startRun } from "../../core/workflows/client.js";
import { appendAudit } from "../../routes/admin/audit-log.js";
import { getLogger } from "../../observability/logger.js";

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export const KickWorkflowAndWaitIn = z.object({
  workflow_id: z.string().uuid(),
  input: z.record(z.string(), z.unknown()).default({}),
  session_id: z.string().uuid().optional(),
  /**
   * Hard ceiling on the wait. Defaults to 5 minutes — the engine's
   * internal step timeouts are typically tighter, but this is the
   * agent-side budget for a "I'll wait inline" call. Bound 1s..1h.
   */
  timeout_seconds: z.number().int().min(1).max(3600).default(300),
  /** Poll interval (seconds). Bound 1s..30s. */
  poll_interval_seconds: z.number().int().min(1).max(30).default(2),
});
export type KickWorkflowAndWaitInput = z.infer<typeof KickWorkflowAndWaitIn>;

export const KickWorkflowAndWaitOut = z.object({
  run_id: z.string(),
  status: z.enum(["succeeded", "failed", "cancelled", "timed_out"]),
  output: z.record(z.string(), z.unknown()).nullable(),
  finished_at: z.string().nullable(),
  events_seen: z.number().int().min(0),
  duration_ms: z.number().int().min(0),
  /** When status='timed_out' or 'failed', the engine's last step_failed
   *  payload (if any) so the agent can decide how to recover. */
  last_failure: z
    .object({ step_id: z.string().nullable(), error: z.string() })
    .nullable(),
});
export type KickWorkflowAndWaitOutput = z.infer<typeof KickWorkflowAndWaitOut>;

export function buildKickWorkflowAndWaitTool(pool: Pool) {
  const log = getLogger("agent-claw.tools.kick_workflow_and_wait");

  return defineTool({
    id: "kick_workflow_and_wait",
    description:
      "Start a workflow run AND poll until it reaches a terminal status " +
      "(succeeded / failed / cancelled / timed_out). Use this for " +
      "synchronous workflows where you want the output before deciding " +
      "the next step. For long-running runs you intend to background, " +
      "use workflow_run + workflow_inspect instead.",
    inputSchema: KickWorkflowAndWaitIn,
    outputSchema: KickWorkflowAndWaitOut,
    annotations: { readOnly: false },

    execute: async (ctx, input) => {
      const startedAt = Date.now();
      const actor = ctx.userEntraId;

      const runId = await startRun(
        pool,
        input.workflow_id,
        input.input ?? {},
        actor,
        input.session_id ?? null,
      );
      await appendAudit(pool, {
        actor,
        action: "workflow.kick_and_wait",
        target: runId,
        afterValue: { workflow_id: input.workflow_id },
      }).catch(() => undefined);

      const timeoutSeconds = input.timeout_seconds ?? 300;
      const pollIntervalSeconds = input.poll_interval_seconds ?? 2;
      const deadline = startedAt + timeoutSeconds * 1000;
      const pollMs = pollIntervalSeconds * 1000;
      let lastEventCount = 0;
      let lastFailure: { step_id: string | null; error: string } | null = null;

      // Cooperative cancellation: respect the parent harness's signal so a
      // client disconnect or upstream abort doesn't leave us polling.
      const signal = ctx.signal;

      for (;;) {
        if (signal?.aborted) {
          throw new Error("kick_workflow_and_wait: aborted by upstream");
        }

        const inspect = await inspectRun(pool, runId, 50);
        lastEventCount = inspect.events.length;

        // Capture the last step_failed payload (if any) to surface in the
        // result so the agent can reason about the error without a
        // separate workflow_inspect round-trip.
        const failedEvent = [...inspect.events]
          .reverse()
          .find((e) => e.kind === "step_failed");
        if (failedEvent) {
          const errPayload = failedEvent.payload as { error?: unknown };
          lastFailure = {
            step_id: failedEvent.step_id,
            error:
              typeof errPayload.error === "string"
                ? errPayload.error
                : JSON.stringify(errPayload.error ?? failedEvent.payload),
          };
        }

        if (TERMINAL_STATUSES.has(inspect.run.status)) {
          return {
            run_id: runId,
            status: inspect.run.status as "succeeded" | "failed" | "cancelled",
            output: inspect.run.output,
            finished_at: inspect.run.finished_at,
            events_seen: inspect.events.length,
            duration_ms: Date.now() - startedAt,
            last_failure: inspect.run.status === "failed" ? lastFailure : null,
          };
        }

        if (Date.now() + pollMs > deadline) {
          // Wait would push us past the deadline — return now with
          // timed_out rather than blocking past the agent's budget. The
          // run continues asynchronously; the agent can call
          // workflow_inspect later if it wants to follow up.
          log.warn(
            {
              event: "kick_workflow_timeout",
              run_id: runId,
              status: inspect.run.status,
              elapsed_ms: Date.now() - startedAt,
            },
            "workflow run did not reach terminal status within timeout",
          );
          return {
            run_id: runId,
            status: "timed_out" as const,
            output: null,
            finished_at: null,
            events_seen: lastEventCount,
            duration_ms: Date.now() - startedAt,
            last_failure: lastFailure,
          };
        }

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, pollMs);
          if (signal) {
            const onAbort = (): void => {
              clearTimeout(timer);
              reject(new Error("kick_workflow_and_wait: aborted by upstream"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
          }
        });
      }
    },
  });
}
