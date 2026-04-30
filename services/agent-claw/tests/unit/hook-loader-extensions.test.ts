// Tests for the Phase 4 extensions to hook-loader.ts:
//   - order: number      → deterministic registration order
//   - condition: { ... } → runtime gate via env var or config setting
//   - timeout_ms: number → forwarded to lifecycle.on for script hooks
//
// Phase 4 of the configuration concept (Initiative 7).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { loadHooks } from "../../src/core/hook-loader.js";
import type { HookDeps } from "../../src/core/hook-loader.js";

let tmpDir: string;

const fakeDeps: HookDeps = {
  pool: undefined as never,
  llm: undefined as never,
  skillLoader: undefined as never,
  allTools: [],
  tokenBudget: 100_000,
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "hook-loader-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeYaml(name: string, body: string): void {
  writeFileSync(join(tmpDir, `${name}.yaml`), body);
}

describe("hook-loader Phase 4 extensions", () => {
  it("registers hooks in ascending order of `order:` field", async () => {
    // Two script-based hooks (so we can use any function) with explicit
    // order values and reversed alphabetical names. Without sorting, the
    // file-name order would put 'b-second' before 'a-first'; with sorting
    // by `order:`, 'a-first' (order 50) goes before 'b-second' (order 200).
    mkdirSync(join(tmpDir, "scripts"), { recursive: true });
    writeFileSync(
      join(tmpDir, "scripts", "first.mjs"),
      "export default async () => ({});",
    );
    writeFileSync(
      join(tmpDir, "scripts", "second.mjs"),
      "export default async () => ({});",
    );
    writeYaml("z-second", `
name: hook-z
lifecycle: post_turn
order: 200
script: scripts/second.mjs
`);
    writeYaml("a-first", `
name: hook-a
lifecycle: post_turn
order: 50
script: scripts/first.mjs
`);

    const lifecycle = new Lifecycle();
    const result = await loadHooks(lifecycle, fakeDeps, tmpDir);
    expect(result.registered).toBe(2);
    // Inspect lifecycle by listing hook names in registration order.
    const names = lifecycle.hookNames("post_turn");
    expect(names).toEqual(["hook-a", "hook-z"]);
  });

  it("falls back to file-name order when `order:` is omitted", async () => {
    mkdirSync(join(tmpDir, "scripts"), { recursive: true });
    writeFileSync(join(tmpDir, "scripts", "x.mjs"), "export default async () => ({});");
    writeFileSync(join(tmpDir, "scripts", "y.mjs"), "export default async () => ({});");
    writeYaml("01-x", "name: x\nlifecycle: post_turn\nscript: scripts/x.mjs\n");
    writeYaml("02-y", "name: y\nlifecycle: post_turn\nscript: scripts/y.mjs\n");

    const lifecycle = new Lifecycle();
    await loadHooks(lifecycle, fakeDeps, tmpDir);
    expect(lifecycle.hookNames("post_turn")).toEqual(["x", "y"]);
  });

  it("skips a hook whose env-var condition evaluates false", async () => {
    delete process.env.MY_FEATURE_FLAG;
    mkdirSync(join(tmpDir, "scripts"), { recursive: true });
    writeFileSync(join(tmpDir, "scripts", "h.mjs"), "export default async () => ({});");
    writeYaml("conditional", `
name: conditional
lifecycle: post_turn
script: scripts/h.mjs
condition:
  env_var: MY_FEATURE_FLAG
  default: false
`);

    const lifecycle = new Lifecycle();
    const result = await loadHooks(lifecycle, fakeDeps, tmpDir);
    expect(result.registered).toBe(0);
    expect(result.skipped[0]).toMatch(/condition false/);
  });

  it("registers a hook whose env-var condition evaluates true", async () => {
    process.env.MY_FEATURE_FLAG = "true";
    mkdirSync(join(tmpDir, "scripts"), { recursive: true });
    writeFileSync(join(tmpDir, "scripts", "h.mjs"), "export default async () => ({});");
    writeYaml("conditional", `
name: conditional
lifecycle: post_turn
script: scripts/h.mjs
condition:
  env_var: MY_FEATURE_FLAG
  default: false
`);

    const lifecycle = new Lifecycle();
    const result = await loadHooks(lifecycle, fakeDeps, tmpDir);
    expect(result.registered).toBe(1);
    delete process.env.MY_FEATURE_FLAG;
  });

  it("uses condition.default when neither setting nor env is present", async () => {
    delete process.env.NEVER_SET;
    mkdirSync(join(tmpDir, "scripts"), { recursive: true });
    writeFileSync(join(tmpDir, "scripts", "h.mjs"), "export default async () => ({});");
    writeYaml("default-on", `
name: default-on
lifecycle: post_turn
script: scripts/h.mjs
condition:
  env_var: NEVER_SET
  default: true
`);

    const lifecycle = new Lifecycle();
    const result = await loadHooks(lifecycle, fakeDeps, tmpDir);
    expect(result.registered).toBe(1);
  });

  it("registers a script hook with timeout_ms (no error)", async () => {
    // The lifecycle's per-hook timeout isn't externally introspectable
    // (private field), but we can assert that loadHooks accepts the YAML
    // and the registration count rises. A future Lifecycle API would let
    // us assert the actual timeout — see hookTimeouts() TODO.
    mkdirSync(join(tmpDir, "scripts"), { recursive: true });
    writeFileSync(join(tmpDir, "scripts", "slow.mjs"), "export default async () => ({});");
    writeYaml("slow", `
name: slow-hook
lifecycle: post_turn
timeout_ms: 5000
script: scripts/slow.mjs
`);

    const lifecycle = new Lifecycle();
    const result = await loadHooks(lifecycle, fakeDeps, tmpDir);
    expect(result.registered).toBe(1);
    expect(lifecycle.hookNames("post_turn")).toEqual(["slow-hook"]);
  });

  it("logs timeout_ms as advisory for built-in hooks", async () => {
    // Built-ins go through BUILTIN_REGISTRARS which doesn't accept a
    // timeout knob today; the loader records the YAML key as advisory.
    writeYaml("redact-secrets-with-timeout", `
name: redact-secrets
lifecycle: post_turn
timeout_ms: 30000
`);

    const lifecycle = new Lifecycle();
    const fakeDepsWithPool: HookDeps = { ...fakeDeps };
    const result = await loadHooks(lifecycle, fakeDepsWithPool, tmpDir);
    expect(result.skipped.some(s => s.includes("timeout_ms ignored"))).toBe(true);
  });
});
