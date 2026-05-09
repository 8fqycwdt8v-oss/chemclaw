// write_file — write a UTF-8 string to a file under AGENT_FS_ROOT.
//
// State-mutating; will overwrite existing files when overwrite=true. The
// permission resolver must allow this tool explicitly (or the harness
// must run in `acceptEdits` mode which auto-allows fs-touching tools).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { defineTool } from "../tool.js";
import { resolveAndCheckPath } from "./_fs_root.js";

const MAX_WRITE_BYTES = 4_194_304; // 4 MiB — generous for code, capped to avoid runaway logs.

export const WriteFileIn = z.object({
  path: z.string().min(1).max(4096),
  content: z.string(),
  /** When true, overwrite an existing file. Default false (refuses if exists). */
  overwrite: z.boolean().default(false),
  /** When true, create missing parent directories. Default false. */
  create_parents: z.boolean().default(false),
});
export type WriteFileInput = z.infer<typeof WriteFileIn>;

export const WriteFileOut = z.object({
  path: z.string(),
  bytes_written: z.number(),
  created: z.boolean(),
  overwritten: z.boolean(),
});
export type WriteFileOutput = z.infer<typeof WriteFileOut>;

export function buildWriteFileTool(root: string) {
  return defineTool({
    id: "write_file",
    description:
      "Write UTF-8 content to a file under AGENT_FS_ROOT. Hard-capped at 4 MiB. " +
      "overwrite=false (default) refuses to clobber. create_parents=true makes " +
      "missing directories. Path is resolved against the root and rejected if " +
      "it escapes via .. or symlinks.",
    inputSchema: WriteFileIn,
    outputSchema: WriteFileOut,
    annotations: { readOnly: false },

    execute: async (_ctx, input): Promise<WriteFileOutput> => {
      const bytes = Buffer.byteLength(input.content, "utf8");
      if (bytes > MAX_WRITE_BYTES) {
        throw new Error(
          `content size ${bytes} exceeds 4 MiB write cap`,
        );
      }
      // mustExist=false lets us write a fresh file; the helper still
      // resolves the parent's realpath and rejects escapes.
      const abs = await resolveAndCheckPath(root, input.path, false);
      let exists = false;
      try {
        // Use stat(abs) probe via dynamic import so we don't reach for `fs`
        // unconditionally — keeps the import surface tight.
        const { stat } = await import("node:fs/promises");
        await stat(abs);
        exists = true;
      } catch {
        exists = false;
      }
      if (exists && !input.overwrite) {
        throw new Error(
          `path '${input.path}' exists and overwrite=false; refuse to clobber`,
        );
      }
      if (input.create_parents) {
        await mkdir(dirname(abs), { recursive: true });
      }
      await writeFile(abs, input.content, { encoding: "utf8" });
      return {
        path: input.path,
        bytes_written: bytes,
        created: !exists,
        overwritten: exists,
      };
    },
  });
}
