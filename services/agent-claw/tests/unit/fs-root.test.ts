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

import { describe as describe2, it as it2, expect as expect2, beforeAll as beforeAll2 } from "vitest";
import { mkdtemp as mkdtemp2, mkdir as mkdir2, writeFile as writeFile2 } from "node:fs/promises";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join2 } from "node:path";
import { buildReadFileTool } from "../../src/tools/builtins/read_file.js";

let readFileRoot: string;
beforeAll2(async () => {
  readFileRoot = await mkdtemp2(join2(tmpdir2(), "chemclaw-rf-"));
  await mkdir2(readFileRoot, { recursive: true });
});

describe2("read_file — OOM guard", () => {
  it2("rejects a file larger than the cap when no slicing requested", async () => {
    const big = join2(readFileRoot, "big.txt");
    // Create a 2 MiB file (2x the 1 MiB cap).
    await writeFile2(big, "x".repeat(2 * 1024 * 1024));
    const tool = buildReadFileTool(readFileRoot);
    const ctx = {
      userEntraId: "u",
      orgId: null,
      nceProjectId: null,
      scratchpad: new Map(),
      seenFactIds: new Set<string>(),
    };
    await expect2(
      tool.execute(ctx, { path: "big.txt" }),
    ).rejects.toThrow(/exceeds.*cap/);
  });

  it2("rejects a file larger than 8x the cap even when slicing IS requested", async () => {
    const huge = join2(readFileRoot, "huge.txt");
    // 9 MiB file, sliced read attempts to grab 100 lines → still rejected.
    await writeFile2(huge, "x".repeat(9 * 1024 * 1024));
    const tool = buildReadFileTool(readFileRoot);
    const ctx = {
      userEntraId: "u",
      orgId: null,
      nceProjectId: null,
      scratchpad: new Map(),
      seenFactIds: new Set<string>(),
    };
    await expect2(
      tool.execute(ctx, { path: "huge.txt", start_line: 1, line_count: 100 }),
    ).rejects.toThrow(/exceeds.*cap/);
  });
});
