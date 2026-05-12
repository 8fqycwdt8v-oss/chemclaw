// list_directory — enumerate the entries of a directory under AGENT_FS_ROOT.
//
// Capped entry count (default 1000) so the LLM doesn't try to list a
// directory with 100k entries and blow the context window.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defineTool } from "../tool.js";
import { resolveAndCheckPath } from "./_fs_root.js";

export const ListDirectoryIn = z.object({
  path: z.string().min(1).max(4096),
  /** Cap on returned entries. Default 1000, max 5000. */
  limit: z.number().int().positive().max(5000).default(1000),
});
export type ListDirectoryInput = z.infer<typeof ListDirectoryIn>;

const EntryOut = z.object({
  name: z.string(),
  kind: z.enum(["file", "directory", "symlink", "other"]),
  size_bytes: z.number().optional(),
});

export const ListDirectoryOut = z.object({
  path: z.string(),
  entries: z.array(EntryOut),
  truncated: z.boolean(),
  total: z.number(),
});
export type ListDirectoryOutput = z.infer<typeof ListDirectoryOut>;

export function buildListDirectoryTool(root: string) {
  return defineTool({
    id: "list_directory",
    description:
      "List entries of a directory under AGENT_FS_ROOT. Returns name + kind " +
      "(file|directory|symlink|other) and size for files. Capped at `limit` " +
      "entries (default 1000); `truncated=true` when the cap was hit.",
    inputSchema: ListDirectoryIn,
    outputSchema: ListDirectoryOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input): Promise<ListDirectoryOutput> => {
      const abs = await resolveAndCheckPath(root, input.path, true);
      const dirents = await readdir(abs, { withFileTypes: true });
      const total = dirents.length;
      const limit = input.limit ?? 1000;
      const slice = dirents.slice(0, limit);
      const entries: ListDirectoryOutput["entries"] = [];
      for (const d of slice) {
        let kind: "file" | "directory" | "symlink" | "other";
        if (d.isFile()) kind = "file";
        else if (d.isDirectory()) kind = "directory";
        else if (d.isSymbolicLink()) kind = "symlink";
        else kind = "other";
        const entry: { name: string; kind: typeof kind; size_bytes?: number } = {
          name: d.name,
          kind,
        };
        if (kind === "file") {
          try {
            const st = await stat(join(abs, d.name));
            entry.size_bytes = st.size;
          } catch {
            // unreadable file — surface kind only
          }
        }
        entries.push(entry);
      }
      return {
        path: input.path,
        entries,
        truncated: total > limit,
        total,
      };
    },
  });
}
