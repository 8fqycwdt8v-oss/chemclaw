// Phase 6: workspace boundary validation.
//
// Filesystem-touching tools (today: run_program's sandbox path inputs; in
// future: any tool that reads a user-supplied path) call assertWithinWorkspace
// before opening the path. The helper rejects:
//   1. Symlinks at the leaf (defense against ../ escapes via traversal).
//   2. Paths whose realpath escapes every allowedRoots entry.
//   3. Files larger than maxFileSizeBytes (default 10 MB).
//
// On success, returns the canonical (realpath) path string so the caller can
// open the canonical reference rather than the input string.

import { realpathSync, statSync, lstatSync } from "node:fs";
import { resolve, relative } from "node:path";

export class WorkspaceBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBoundaryError";
  }
}

export interface BoundaryOptions {
  /** Absolute paths the call may touch. Default: empty (everything denied). */
  allowedRoots: string[];
  /** Default 10 MB. */
  maxFileSizeBytes?: number;
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Validate that `path` is safe to read for a sandboxed tool call.
 *
 * Throws WorkspaceBoundaryError on rejection. Returns the canonical path
 * (realpath) on success — callers should open that, not the original input,
 * to defeat TOCTOU races where a parent directory is swapped after this
 * check passes.
 */
export function assertWithinWorkspace(
  path: string,
  opts: BoundaryOptions,
): string {
  // 1. Reject leaf symlinks. realpathSync would silently resolve them, so
  //    lstat first to surface the symlink at the call site.
  let lstat;
  try {
    lstat = lstatSync(path);
  } catch (err) {
    throw new WorkspaceBoundaryError(
      `refused: cannot stat ${path} — ${(err as Error).message}`,
    );
  }
  if (lstat.isSymbolicLink()) {
    throw new WorkspaceBoundaryError(`refused: symlink at ${path}`);
  }

  // 2. Resolve to canonical path; reject if not under any allowed root.
  let real: string;
  try {
    real = realpathSync(resolve(path));
  } catch (err) {
    throw new WorkspaceBoundaryError(
      `refused: cannot resolve ${path} — ${(err as Error).message}`,
    );
  }

  const inside = opts.allowedRoots.some((root) => {
    let realRoot: string;
    try {
      realRoot = realpathSync(resolve(root));
    } catch {
      // Roots that don't exist are skipped rather than throwing — a missing
      // allowed root simply doesn't grant access.
      return false;
    }
    const rel = relative(realRoot, real);
    // rel === "" → real IS the root.
    // !rel.startsWith("..") AND no "../" segment → real is a descendant.
    return rel === "" || (!rel.startsWith("..") && !rel.includes("../"));
  });
  if (!inside) {
    throw new WorkspaceBoundaryError(
      `refused: ${real} escapes allowed roots ${opts.allowedRoots.join(",")}`,
    );
  }

  // 3. Size cap (only meaningful for regular files).
  const stat = statSync(real);
  const cap = opts.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  if (stat.isFile() && stat.size > cap) {
    throw new WorkspaceBoundaryError(
      `refused: file size ${stat.size} > cap ${cap}`,
    );
  }

  return real;
}
