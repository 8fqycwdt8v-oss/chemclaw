// JSON-RPC over stdio protocol for the Monty orchestration runtime.
//
// The host (this Node process) and the child (a Python script that wraps
// the Monty interpreter) exchange line-delimited JSON frames. Each line is
// one complete frame. The protocol is the only contract between the host
// and any child implementation — swap the binary, keep the framing.
//
// Direction:
//   host → child: StartFrame, ExternalResponseFrame, ShutdownFrame
//   child → host: ExternalCallFrame, LogFrame, ResultFrame, ErrorFrame, ReadyFrame
//
// All frames carry a discriminating `type` field. Unknown frames are ignored
// by both sides so the protocol can grow additively.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Frames sent FROM the host TO the child.
// ---------------------------------------------------------------------------

export const StartFrame = z.object({
  type: z.literal("start"),
  /** Run id — echoed back on Result/Error/ExternalCall frames. */
  run_id: z.string(),
  /** Python source to execute. */
  script: z.string(),
  /** Tool ids the child may invoke via external_function(...). */
  allowed_tools: z.array(z.string()),
  /** Named inputs injected as Python globals before the script runs. */
  inputs: z.record(z.unknown()),
  /** Variable names the script is expected to set; harvested as outputs. */
  expected_outputs: z.array(z.string()),
  /** Hard wall-clock cap for the child to honour (ms). */
  wall_time_ms: z.number().int().min(1),
  /** Hard cap on number of external_function calls the child may issue. */
  max_external_calls: z.number().int().min(0),
});
export type StartFrameT = z.infer<typeof StartFrame>;

export const ExternalResponseFrame = z.object({
  type: z.literal("external_response"),
  /** Echo of ExternalCallFrame.id. */
  id: z.number().int(),
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.string().optional(),
});
export type ExternalResponseFrameT = z.infer<typeof ExternalResponseFrame>;

export const ShutdownFrame = z.object({
  type: z.literal("shutdown"),
});
export type ShutdownFrameT = z.infer<typeof ShutdownFrame>;

export const HostToChildFrame = z.discriminatedUnion("type", [
  StartFrame,
  ExternalResponseFrame,
  ShutdownFrame,
]);
export type HostToChildFrameT = z.infer<typeof HostToChildFrame>;

// ---------------------------------------------------------------------------
// Frames sent FROM the child TO the host.
// ---------------------------------------------------------------------------

export const ReadyFrame = z.object({
  type: z.literal("ready"),
  /** Optional version string the child reports — useful for diagnostics. */
  child_version: z.string().optional(),
});
export type ReadyFrameT = z.infer<typeof ReadyFrame>;

export const ExternalCallFrame = z.object({
  type: z.literal("external_call"),
  /** Monotonic call id; the host echoes this on ExternalResponseFrame. */
  id: z.number().int(),
  name: z.string(),
  args: z.unknown(),
});
export type ExternalCallFrameT = z.infer<typeof ExternalCallFrame>;

export const LogFrame = z.object({
  type: z.literal("log"),
  stream: z.enum(["stdout", "stderr"]),
  message: z.string(),
});
export type LogFrameT = z.infer<typeof LogFrame>;

export const ResultFrame = z.object({
  type: z.literal("result"),
  run_id: z.string(),
  outputs: z.record(z.unknown()),
});
export type ResultFrameT = z.infer<typeof ResultFrame>;

export const ErrorFrame = z.object({
  type: z.literal("error"),
  run_id: z.string(),
  /** Single-line error summary for tool output. */
  error: z.string(),
  /** Optional multi-line traceback for diagnostics. */
  traceback: z.string().optional(),
});
export type ErrorFrameT = z.infer<typeof ErrorFrame>;

export const ChildToHostFrame = z.discriminatedUnion("type", [
  ReadyFrame,
  ExternalCallFrame,
  LogFrame,
  ResultFrame,
  ErrorFrame,
]);
export type ChildToHostFrameT = z.infer<typeof ChildToHostFrame>;

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Serialise a host→child frame to a line-terminated JSON string.
 * The trailing \n is the line delimiter; the child reads one line at a time.
 */
export function encodeFrame(frame: HostToChildFrameT): string {
  return JSON.stringify(frame) + "\n";
}

/**
 * Parse one line as a child→host frame. Returns the typed frame on success
 * or null when the line is empty / not valid JSON / not a known frame shape.
 * Unknown shapes are discarded silently so the protocol can grow additively.
 */
export function decodeFrame(line: string): ChildToHostFrameT | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsed = ChildToHostFrame.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
