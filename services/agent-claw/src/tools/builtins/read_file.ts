// read_file — read a UTF-8 text file under AGENT_FS_ROOT.
//
// Hard-capped at MAX_BYTES (1 MiB) so a runaway tool can't pin memory by
// reading a 10GB log. For binary or larger payloads the model should call
// list_directory + decide whether to escalate.

import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { defineTool } from "../tool.js";
import { resolveAndCheckPath } from "./_fs_root.js";

export const ReadFileIn = z.object({
  path: z.string().min(1).max(4096),
  /** Optional 1-indexed start line; reads from the start when omitted. */
  start_line: z.number().int().positive().optional(),
  /** Optional line count; reads to EOF when omitted. */
  line_count: z.number().int().positive().max(20_000).optional(),
});
export type ReadFileInput = z.infer<typeof ReadFileIn>;

export const ReadFileOut = z.object({
  path: z.string(),
  /** Total bytes in the underlying file (NOT the slice returned). */
  size_bytes: z.number(),
  /** UTF-8 content of the requested slice. */
  content: z.string(),
  /** True when the slice is the entire file; false when start_line/line_count
   *  truncated it. */
  complete: z.boolean(),
  /** Total line count of the underlying file (informational). */
  total_lines: z.number(),
});
export type ReadFileOutput = z.infer<typeof ReadFileOut>;

const MAX_BYTES = 1_048_576;

export function buildReadFileTool(root: string) {
  return defineTool({
    id: "read_file",
    description:
      "Read a UTF-8 text file under AGENT_FS_ROOT. Capped at 1 MiB. " +
      "Pass start_line + line_count to read a slice of large files. " +
      "Refuses paths that resolve outside AGENT_FS_ROOT.",
    inputSchema: ReadFileIn,
    outputSchema: ReadFileOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input): Promise<ReadFileOutput> => {
      const abs = await resolveAndCheckPath(root, input.path, true);
      const st = await stat(abs);
      if (!st.isFile()) {
        throw new Error(`path '${input.path}' is not a regular file`);
      }
      if (st.size > MAX_BYTES && !input.start_line && !input.line_count) {
        throw new Error(
          `file size ${st.size} exceeds 1 MiB cap; pass start_line + line_count to read a slice`,
        );
      }
      const fullContent = await readFile(abs, { encoding: "utf8" });
      // Truncate hard at MAX_BYTES even if start_line/line_count were used,
      // so a slice on a multi-GB file still respects the memory cap.
      const allLines = fullContent.split(/\r?\n/);
      const totalLines = allLines.length;
      let slice = allLines;
      let complete = true;
      if (input.start_line || input.line_count) {
        const startIdx = (input.start_line ?? 1) - 1;
        const count = input.line_count ?? totalLines - startIdx;
        slice = allLines.slice(startIdx, startIdx + count);
        complete = startIdx === 0 && slice.length === totalLines;
      }
      let content = slice.join("\n");
      if (Buffer.byteLength(content, "utf8") > MAX_BYTES) {
        // Trim to the byte cap. Cut on a UTF-8 boundary by re-encoding
        // and slicing the buffer.
        const buf = Buffer.from(content, "utf8").subarray(0, MAX_BYTES);
        content = buf.toString("utf8");
        complete = false;
      }
      return {
        path: input.path,
        size_bytes: st.size,
        content,
        complete,
        total_lines: totalLines,
      };
    },
  });
}
