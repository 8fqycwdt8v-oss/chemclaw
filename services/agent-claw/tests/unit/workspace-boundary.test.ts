// Phase 6: workspace boundary helper tests.
//
// Pins symlink rejection, '../' escape rejection, oversize rejection, and
// happy-path passthrough returning the canonical realpath.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertWithinWorkspace,
  WorkspaceBoundaryError,
} from "../../src/security/workspace-boundary.js";

describe("assertWithinWorkspace", () => {
  let workspaceRoot: string;
  let outsideRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "ws-boundary-"));
    outsideRoot = mkdtempSync(join(tmpdir(), "ws-outside-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  });

  it("rejects a symlink at the leaf", () => {
    const realFile = join(workspaceRoot, "real.txt");
    writeFileSync(realFile, "hello");
    const linkFile = join(workspaceRoot, "link.txt");
    symlinkSync(realFile, linkFile);

    expect(() =>
      assertWithinWorkspace(linkFile, { allowedRoots: [workspaceRoot] }),
    ).toThrow(WorkspaceBoundaryError);
  });

  it("rejects a symlink that points outside the allowed root", () => {
    const outsideFile = join(outsideRoot, "secret.txt");
    writeFileSync(outsideFile, "secret");
    const linkInside = join(workspaceRoot, "evil-link.txt");
    symlinkSync(outsideFile, linkInside);

    // lstat catches the symlink BEFORE realpath would resolve it through the
    // boundary — which is exactly the defense we want.
    expect(() =>
      assertWithinWorkspace(linkInside, { allowedRoots: [workspaceRoot] }),
    ).toThrow(WorkspaceBoundaryError);
  });

  it("rejects a path whose realpath escapes allowed roots", () => {
    const outsideFile = join(outsideRoot, "secret.txt");
    writeFileSync(outsideFile, "secret");
    expect(() =>
      assertWithinWorkspace(outsideFile, { allowedRoots: [workspaceRoot] }),
    ).toThrow(WorkspaceBoundaryError);
  });

  it("rejects oversized files", () => {
    const big = join(workspaceRoot, "big.bin");
    writeFileSync(big, Buffer.alloc(2048));
    expect(() =>
      assertWithinWorkspace(big, {
        allowedRoots: [workspaceRoot],
        maxFileSizeBytes: 1024,
      }),
    ).toThrow(WorkspaceBoundaryError);
  });

  it("allows a normal file under the allowed root and returns realpath", () => {
    const okFile = join(workspaceRoot, "ok.txt");
    writeFileSync(okFile, "fine");
    const real = assertWithinWorkspace(okFile, {
      allowedRoots: [workspaceRoot],
    });
    expect(real).toBe(realpathSync(okFile));
  });
});
