// Tests for the YAML hook loader.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { loadHooks } from "../../src/core/hook-loader.js";
import { mockHookDeps } from "../helpers/mocks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hook-loader-test-"));
}

async function writeYaml(dir: string, name: string, content: string): Promise<void> {
  await writeFile(join(dir, name), content, "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadHooks — empty directory", () => {
  it("returns zero files and zero registered when dir is empty", async () => {
    const dir = await makeTmpDir();
    try {
      const lc = new Lifecycle();
      const result = await loadHooks(lc, mockHookDeps(), dir);
      expect(result.filesFound).toBe(0);
      expect(result.registered).toBe(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("returns zero registered when hooks dir does not exist", async () => {
    const lc = new Lifecycle();
    const result = await loadHooks(lc, mockHookDeps(), "/tmp/nonexistent-hooks-dir-xyz");
    expect(result.filesFound).toBe(0);
    expect(result.registered).toBe(0);
  });
});

describe("loadHooks — built-in hooks", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTmpDir();
  });

  it("registers built-in redact-secrets hook into lifecycle", async () => {
    await writeYaml(
      dir,
      "redact-secrets.yaml",
      `
name: redact-secrets
lifecycle: post_turn
enabled: true
`,
    );
    const lc = new Lifecycle();
    const result = await loadHooks(lc, mockHookDeps(), dir);
    expect(result.registered).toBe(1);
    expect(result.skipped).toHaveLength(0);
    // post_turn should have 1 registered handler (redact-secrets ignores the
    // YAML lifecycle field for built-in hooks; the registrar function decides).
    expect(lc.count("post_turn")).toBe(1);
  });

  it("registers built-in tag-maturity hook into lifecycle", async () => {
    await writeYaml(
      dir,
      "tag-maturity.yaml",
      `
name: tag-maturity
lifecycle: post_tool
enabled: true
`,
    );
    const lc = new Lifecycle();
    const result = await loadHooks(lc, mockHookDeps(), dir);
    expect(result.registered).toBe(1);
    expect(lc.count("post_tool")).toBe(1);
  });

  it("registers built-in budget-guard hook into lifecycle", async () => {
    await writeYaml(
      dir,
      "budget-guard.yaml",
      `
name: budget-guard
lifecycle: pre_tool
enabled: true
`,
    );
    const lc = new Lifecycle();
    const result = await loadHooks(lc, mockHookDeps(), dir);
    expect(result.registered).toBe(1);
    expect(lc.count("pre_tool")).toBe(1);
  });

  it("skips disabled hooks and does not register them", async () => {
    await writeYaml(
      dir,
      "redact-secrets.yaml",
      `
name: redact-secrets
lifecycle: post_turn
enabled: false
`,
    );
    const lc = new Lifecycle();
    const result = await loadHooks(lc, mockHookDeps(), dir);
    expect(result.registered).toBe(0);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(lc.count("post_turn")).toBe(0);
  });

  it("registers multiple hooks from multiple files", async () => {
    await writeYaml(dir, "redact-secrets.yaml", `name: redact-secrets\nlifecycle: post_turn\nenabled: true`);
    await writeYaml(dir, "tag-maturity.yaml", `name: tag-maturity\nlifecycle: post_tool\nenabled: true`);
    await writeYaml(dir, "budget-guard.yaml", `name: budget-guard\nlifecycle: pre_tool\nenabled: true`);

    const lc = new Lifecycle();
    const result = await loadHooks(lc, mockHookDeps(), dir);
    expect(result.filesFound).toBe(3);
    expect(result.registered).toBe(3);
    // pre_tool has budget-guard = 1 handler (redact-secrets is post_turn now).
    expect(lc.count("pre_tool")).toBe(1);
    // post_tool has tag-maturity = 1 handler.
    expect(lc.count("post_tool")).toBe(1);
    // post_turn has redact-secrets = 1 handler.
    expect(lc.count("post_turn")).toBe(1);

    await rm(dir, { recursive: true });
  });

  it("skips a hook with an invalid lifecycle value", async () => {
    await writeYaml(
      dir,
      "bad-hook.yaml",
      `name: redact-secrets\nlifecycle: invalid_point\nenabled: true`,
    );
    const lc = new Lifecycle();
    const result = await loadHooks(lc, mockHookDeps(), dir);
    expect(result.registered).toBe(0);
    expect(result.skipped.some((s) => s.includes("invalid lifecycle"))).toBe(true);

    await rm(dir, { recursive: true });
  });

  it("skips a YAML file with parse errors", async () => {
    await writeFile(join(dir, "broken.yaml"), ": : bad yaml {{{", "utf8");
    const lc = new Lifecycle();
    const result = await loadHooks(lc, mockHookDeps(), dir);
    expect(result.registered).toBe(0);
    expect(result.skipped.some((s) => s.includes("YAML parse error"))).toBe(true);

    await rm(dir, { recursive: true });
  });

  it("skips a hook with unknown built-in name", async () => {
    await writeYaml(dir, "unknown.yaml", `name: not-a-builtin\nlifecycle: pre_tool\nenabled: true`);
    const lc = new Lifecycle();
    const result = await loadHooks(lc, mockHookDeps(), dir);
    expect(result.registered).toBe(0);
    expect(result.skipped.some((s) => s.includes('no built-in registrar'))).toBe(true);

    await rm(dir, { recursive: true });
  });
});
