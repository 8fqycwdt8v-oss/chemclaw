// Phase C2 — run_shell allowlist + path-separator rejection.
//
// We can't actually exercise spawn() here without a sandbox, but we can
// verify the input-validation guards (allowlist check, path-separator
// rejection) before any subprocess is started. These guards are the
// primary trust boundary; the spawn-side controls (timeout, env strip,
// stream caps) are tested via the type system + integration smoke.

import { describe, it, expect } from "vitest";
import { buildRunShellTool } from "../../src/tools/builtins/run_shell.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../../src/core/types.js";

function makeCtx(): ToolContext {
  return {
    userEntraId: "u",
    scratchpad: new Map<string, unknown>(),
    seenFactIds: new Set<string>(),
  };
}

describe("run_shell — guards", () => {
  it("refuses every call when allowlist is empty", async () => {
    const tool = buildRunShellTool({
      root: "/tmp",
      allowlist: [],
      timeoutMs: 1000,
    });
    await expect(
      tool.execute(makeCtx(), { command: "ls", args: [], cwd: "." }),
    ).rejects.toThrow(/disabled/);
  });

  it("rejects an absolute path even if its basename is allowlisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "chemclaw-shell-"));
    const tool = buildRunShellTool({
      root,
      allowlist: ["ls"],
      timeoutMs: 1000,
    });
    await expect(
      tool.execute(makeCtx(), { command: "/usr/bin/ls", args: [], cwd: "." }),
    ).rejects.toThrow(/path separator/);
  });

  it("rejects a relative path with a separator", async () => {
    const root = await mkdtemp(join(tmpdir(), "chemclaw-shell-"));
    const tool = buildRunShellTool({
      root,
      allowlist: ["ls"],
      timeoutMs: 1000,
    });
    await expect(
      tool.execute(makeCtx(), { command: "./bin/ls", args: [], cwd: "." }),
    ).rejects.toThrow(/path separator/);
  });

  it("rejects a command not in the allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "chemclaw-shell-"));
    const tool = buildRunShellTool({
      root,
      allowlist: ["ls"],
      timeoutMs: 1000,
    });
    await expect(
      tool.execute(makeCtx(), { command: "rm", args: ["-rf", "/"], cwd: "." }),
    ).rejects.toThrow(/not in AGENT_SHELL_ALLOWLIST/);
  });
});
