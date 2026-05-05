// Monty host — orchestrates one script run end-to-end.
//
// Lifecycle of a single MontyHost.run() call:
//   1. Acquire (or spawn) a child via the configured factory.
//   2. Wait for the child's "ready" frame (with timeout).
//   3. Send a "start" frame carrying the script + allow-list + inputs.
//   4. Loop on incoming child→host frames:
//        - external_call → route through the bridge → external_response
//        - log           → append to stdout/stderr buffers
//        - result        → resolve the run with outputs
//        - error         → resolve the run with a typed error
//      Wall-time timeout in parallel; on tripping, kill the child.
//   5. Either way, surface a structured RunResult so the builtin can shape
//      its tool output without further orchestration.
//
// The host is intentionally I/O-only: it doesn't decide policy (allow-list
// validation, span attributes) — those live in the bridge and the builtin.
// This keeps the host testable with a fake child adapter.

import type { Lifecycle } from "../../core/lifecycle.js";
import type { PermissionOptions, ToolContext } from "../../core/types.js";
import type { Tool } from "../../tools/tool.js";
import { getLogger } from "../../observability/logger.js";
import { routeExternalCall, type BridgeCallTrace } from "./bridge.js";
import type { MontyChild, MontyChildFactory } from "./child-adapter.js";
import type {
  ChildToHostFrameT,
  ExternalCallFrameT,
  ExternalResponseFrameT,
} from "./protocol.js";

const READY_TIMEOUT_MS = 5_000;

export interface MontyHostOptions {
  childFactory: MontyChildFactory;
  registry: { get(id: string): Tool | undefined };
  lifecycle: Lifecycle;
}

export interface RunOptions {
  runId: string;
  script: string;
  allowedTools: string[];
  inputs: Record<string, unknown>;
  expectedOutputs: string[];
  wallTimeMs: number;
  maxExternalCalls: number;
  ctx: ToolContext;
  permissions?: PermissionOptions;
  /**
   * Optional upstream signal (e.g. ctx.signal). When it aborts, the host
   * kills the child and surfaces a `cancelled` error.
   */
  signal?: AbortSignal;
}

export type RunOutcome =
  | { kind: "ok"; outputs: Record<string, unknown> }
  | { kind: "error"; error: string; traceback?: string }
  | { kind: "timeout"; wallTimeMs: number }
  | { kind: "cancelled" }
  | { kind: "child_crashed"; exitCode: number | null; signal: NodeJS.Signals | null };

export interface RunResult {
  outcome: RunOutcome;
  stdout: string;
  stderr: string;
  /** Per-external-call trace, in call order. */
  externalCalls: BridgeCallTrace[];
  durationMs: number;
}

export class MontyHost {
  constructor(private readonly opts: MontyHostOptions) {}

  async run(runOpts: RunOptions): Promise<RunResult> {
    const startedAt = Date.now();
    const log = getLogger("agent-claw.runtime.monty.host");
    const child = this.opts.childFactory();

    let stdoutBuf = "";
    let stderrBuf = "";
    const externalCalls: BridgeCallTrace[] = [];
    let externalCallCount = 0;
    const allowedToolIds = new Set(runOpts.allowedTools);

    let wallTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;

    return await new Promise<RunResult>((resolve) => {
      const finish = (outcome: RunOutcome): void => {
        if (resolved) return;
        resolved = true;
        if (wallTimer) clearTimeout(wallTimer);
        // Best-effort: tell the child to shut down so it can return to the
        // pool. If it's already dead, kill is a no-op.
        try {
          if (child.alive) child.send({ type: "shutdown" });
        } catch {
          // child already dead — fall through.
        }
        if (child.alive) child.kill();
        resolve({
          outcome,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          externalCalls,
          durationMs: Date.now() - startedAt,
        });
      };

      // Wall-time timer.
      wallTimer = setTimeout(() => {
        log.warn(
          { event: "monty_wall_time_exceeded", run_id: runOpts.runId, wall_time_ms: runOpts.wallTimeMs },
          "killing Monty child — script exceeded wall time",
        );
        finish({ kind: "timeout", wallTimeMs: runOpts.wallTimeMs });
      }, runOpts.wallTimeMs);

      // Upstream signal cancellation.
      if (runOpts.signal) {
        if (runOpts.signal.aborted) {
          finish({ kind: "cancelled" });
          return;
        }
        runOpts.signal.addEventListener(
          "abort",
          () => {
            finish({ kind: "cancelled" });
          },
          { once: true },
        );
      }

      // Stderr passthrough — accumulate for the result.
      child.on("stderr_line", (line) => {
        stderrBuf += line + "\n";
      });

      // Child crash before we even kicked off counts as a child_crashed
      // outcome. After we've resolved with another outcome, the exit is
      // expected (we sent "shutdown" / killed) and we ignore it.
      child.on("exit", (code, signal) => {
        if (!resolved) {
          finish({ kind: "child_crashed", exitCode: code, signal });
        }
      });
      child.on("error", (err) => {
        log.error(
          { event: "monty_child_adapter_error", run_id: runOpts.runId, err: err.message },
          "Monty child adapter error",
        );
        if (!resolved) {
          finish({ kind: "error", error: err.message });
        }
      });

      // Frame handler.
      let started = false;
      child.on("frame", (frame: ChildToHostFrameT) => {
        if (resolved) return;

        if (frame.type === "ready") {
          if (started) return;
          started = true;
          try {
            child.send({
              type: "start",
              run_id: runOpts.runId,
              script: runOpts.script,
              allowed_tools: runOpts.allowedTools,
              inputs: runOpts.inputs,
              expected_outputs: runOpts.expectedOutputs,
              wall_time_ms: runOpts.wallTimeMs,
              max_external_calls: runOpts.maxExternalCalls,
            });
          } catch (err) {
            finish({
              kind: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }

        if (frame.type === "log") {
          if (frame.stream === "stdout") stdoutBuf += frame.message + "\n";
          else stderrBuf += frame.message + "\n";
          return;
        }

        if (frame.type === "external_call") {
          void this._handleExternalCall(
            frame,
            child,
            allowedToolIds,
            runOpts,
            externalCalls,
            ++externalCallCount,
            (response) => {
              if (!resolved && child.alive) {
                try {
                  child.send(response);
                } catch (err) {
                  log.warn(
                    {
                      event: "monty_external_response_send_failed",
                      run_id: runOpts.runId,
                      err: err instanceof Error ? err.message : String(err),
                    },
                    "failed to send external_response — child likely dead",
                  );
                }
              }
            },
          );
          return;
        }

        if (frame.type === "result") {
          finish({ kind: "ok", outputs: frame.outputs });
          return;
        }

        // Only `error` frames remain — discriminated union narrowed.
        finish({ kind: "error", error: frame.error, traceback: frame.traceback });
      });

      // Hand-off to ready timer.
      const readyDeadline = setTimeout(() => {
        if (!started && !resolved) {
          log.warn(
            { event: "monty_ready_timeout", run_id: runOpts.runId },
            "Monty child did not emit ready frame within deadline",
          );
          finish({ kind: "error", error: "child did not become ready" });
        }
      }, READY_TIMEOUT_MS);
      readyDeadline.unref();
    });
  }

  private async _handleExternalCall(
    frame: ExternalCallFrameT,
    child: MontyChild,
    allowedToolIds: ReadonlySet<string>,
    runOpts: RunOptions,
    externalCalls: BridgeCallTrace[],
    callIndex: number,
    sendResponse: (response: ExternalResponseFrameT) => void,
  ): Promise<void> {
    if (callIndex > runOpts.maxExternalCalls) {
      const message = `external_function call cap exceeded (max ${runOpts.maxExternalCalls})`;
      externalCalls.push({
        toolId: frame.name,
        durationMs: 0,
        ok: false,
        errorMessage: message,
      });
      sendResponse({
        type: "external_response",
        id: frame.id,
        ok: false,
        error: message,
      });
      return;
    }

    const { response, trace } = await routeExternalCall(frame, {
      registry: this.opts.registry,
      allowedToolIds,
      ctx: runOpts.ctx,
      lifecycle: this.opts.lifecycle,
      permissions: runOpts.permissions,
    });
    externalCalls.push(trace);
    sendResponse(response);
  }
}
