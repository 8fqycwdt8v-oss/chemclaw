// Phase C1 — _fs_root path-escape protection.

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PathEscapesRootError,
  resolveAndCheckPath,
} from "../../src/tools/builtins/_fs_root.js";

let root: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "chemclaw-fsroot-"));
  outside = await mkdtemp(join(tmpdir(), "chemclaw-outside-"));
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "ok.txt"), "hello");
  await writeFile(join(outside, "secret.txt"), "secret");
});

describe("resolveAndCheckPath", () => {
  it("accepts a file under the root", async () => {
    const abs = await resolveAndCheckPath(root, "ok.txt", true);
    expect(abs.endsWith("ok.txt")).toBe(true);
  });

  it("rejects relative .. traversal", async () => {
    await expect(
      resolveAndCheckPath(root, "../outside.txt", false),
    ).rejects.toBeDefined();
  });

  it("rejects absolute paths outside the root", async () => {
    await expect(
      resolveAndCheckPath(root, join(outside, "secret.txt"), true),
    ).rejects.toThrow(PathEscapesRootError);
  });

  it("rejects symlinks pointing outside the root", async () => {
    const linkPath = join(root, "escape-link");
    try {
      await symlink(join(outside, "secret.txt"), linkPath);
      await expect(
        resolveAndCheckPath(root, "escape-link", true),
      ).rejects.toThrow(PathEscapesRootError);
    } finally {
      await rm(linkPath, { force: true });
    }
  });

  it("allows a non-existent path under the root for write (mustExist=false)", async () => {
    const abs = await resolveAndCheckPath(root, "sub/new-file.txt", false);
    expect(abs).toContain("sub");
  });
});
