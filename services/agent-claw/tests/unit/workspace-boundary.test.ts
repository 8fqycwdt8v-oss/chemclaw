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

  // ---------- H5: edge cases the original suite missed ---------------------

  it("rejects composed '..' traversal even after path.resolve normalisation", () => {
    // Construct a path that LOOKS like it sits inside workspaceRoot but
    // resolves outside via embedded `..` segments. realpathSync must
    // canonicalise BEFORE the boundary check so this fails.
    const outsideFile = join(outsideRoot, "secret.txt");
    writeFileSync(outsideFile, "secret");
    const traversal = join(workspaceRoot, "..", "..", outsideRoot, "secret.txt");
    expect(() =>
      assertWithinWorkspace(traversal, { allowedRoots: [workspaceRoot] }),
    ).toThrow(WorkspaceBoundaryError);
  });

  it("rejects everything when allowedRoots is empty", () => {
    const okFile = join(workspaceRoot, "ok.txt");
    writeFileSync(okFile, "fine");
    expect(() =>
      assertWithinWorkspace(okFile, { allowedRoots: [] }),
    ).toThrow(WorkspaceBoundaryError);
  });

  it("rejects a path containing a NUL byte (lstat refuses it)", () => {
    // Node.js fs APIs reject paths with embedded NULs — the helper surfaces
    // that as a WorkspaceBoundaryError instead of leaking the raw TypeError
    // to the caller.
    const nulPath = `${workspaceRoot}/ok.txt\0secret`;
    expect(() =>
      assertWithinWorkspace(nulPath, { allowedRoots: [workspaceRoot] }),
    ).toThrow();
  });

  it("rejects when a parent directory is a symlink to outside the root", () => {
    // Create: outsideRoot/dir/file.txt
    //         workspaceRoot/proxy -> outsideRoot/dir
    //         input: workspaceRoot/proxy/file.txt
    // The leaf isn't a symlink (lstat returns false) but realpath escapes
    // the workspace root via the parent symlink. The boundary check on the
    // canonical path must reject.
    const outsideDir = join(outsideRoot, "dir");
    const outsideFile = join(outsideDir, "file.txt");
    const fs = require("node:fs");
    fs.mkdirSync(outsideDir, { recursive: true });
    writeFileSync(outsideFile, "secret");
    const proxyLink = join(workspaceRoot, "proxy");
    symlinkSync(outsideDir, proxyLink);
    const sneakyInput = join(proxyLink, "file.txt");

    expect(() =>
      assertWithinWorkspace(sneakyInput, { allowedRoots: [workspaceRoot] }),
    ).toThrow(WorkspaceBoundaryError);
  });

  it("rejects a path that does not exist (lstat throws ENOENT)", () => {
    const ghost = join(workspaceRoot, "does-not-exist.txt");
    expect(() =>
      assertWithinWorkspace(ghost, { allowedRoots: [workspaceRoot] }),
    ).toThrow(WorkspaceBoundaryError);
  });

  it("rejects an empty-string input (lstat throws ENOENT)", () => {
    expect(() =>
      assertWithinWorkspace("", { allowedRoots: [workspaceRoot] }),
    ).toThrow(WorkspaceBoundaryError);
  });
});
