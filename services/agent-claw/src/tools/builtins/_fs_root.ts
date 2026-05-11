// Path-resolution helpers shared by the filesystem builtins (read_file,
// write_file, edit_file, list_directory) so they enforce a single
// trust-boundary contract: every path the agent supplies is resolved
// against AGENT_FS_ROOT, then verified to live inside it. Any input that
// escapes (relative `..` traversal, absolute paths outside the root,
// symlink-aided escape) is rejected with a typed error.
//
// Symlinks: we resolve via fs.realpath when the path exists. For writes
// to non-existent paths we resolve the parent's realpath and check that
// it stays under the root. This closes the symlink-escape pattern where
// an attacker dangling a symlink to /etc/passwd could write outside the
// root.

import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";

export class PathEscapesRootError extends Error {
  readonly absRoot: string;
  readonly absPath: string;
  constructor(absRoot: string, absPath: string) {
    super(`path '${absPath}' resolves outside AGENT_FS_ROOT '${absRoot}'`);
    this.name = "PathEscapesRootError";
    this.absRoot = absRoot;
    this.absPath = absPath;
  }
}

/**
 * Resolve `userPath` against `root` and ensure the result stays under it.
 * Throws PathEscapesRootError on any escape attempt.
 *
 * `mustExist` controls whether we resolve symlinks via realpath:
 *   - true   — fs.realpath(absPath); fails if the path doesn't exist.
 *   - false  — fs.realpath(parent(absPath)) and re-join the basename.
 *              Used by write/edit so a fresh-create path can still be
 *              checked without the file existing yet.
 */
export async function resolveAndCheckPath(
  root: string,
  userPath: string,
  mustExist: boolean,
): Promise<string> {
  const absRoot = await realpath(root);
  // Reject empty + obviously-bad inputs before doing IO so the failure mode
  // is consistent.
  if (typeof userPath !== "string" || userPath.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  // Allow either absolute (must already be under root) or relative to root.
  const absInput = isAbsolute(userPath) ? userPath : resolve(absRoot, userPath);
  const normalized = normalize(absInput);

  let real: string;
  if (mustExist) {
    real = await realpath(normalized);
  } else {
    // Resolve the parent's realpath (must exist) and re-attach the basename.
    const parent = dirname(normalized);
    const realParent = await realpath(parent);
    real = resolve(realParent, normalized.slice(parent.length).replace(/^[/\\]/, ""));
  }
  // The relative path from root to the resolved location must NOT start
  // with ".." (which would indicate an escape) and must NOT be absolute.
  const rel = relative(absRoot, real);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathEscapesRootError(absRoot, real);
  }
  return real;
}
