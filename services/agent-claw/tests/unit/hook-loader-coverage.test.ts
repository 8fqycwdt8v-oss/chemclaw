// Phase 1A coverage test — guarantees that every YAML hook descriptor in
// `hooks/` resolves to a registered built-in handler, and that the 9 known
// hook implementations register at the right lifecycle points.
//
// This test is intentionally read-only against the on-disk `hooks/` directory
// (the canonical source of truth). It locks in the invariant that adding a
// new YAML file without a matching registrar will fail CI.

import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { loadHooks } from "../../src/core/hook-loader.js";
import { mockHookDeps } from "../helpers/mocks.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const hooksDir = resolve(repoRoot, "hooks");

describe("hook loader coverage", () => {
  it("registers every YAML hook (no skips for missing registrar)", async () => {
    const lc = new Lifecycle();
    const result = await loadHooks(lc, mockHookDeps(), hooksDir);
    const skipsForMissingRegistrar = result.skipped.filter((s) =>
      s.includes("no built-in registrar"),
    );
    expect(skipsForMissingRegistrar).toEqual([]);
  });

  it("registers all 9 known hook implementations at the right points", async () => {
    const lc = new Lifecycle();
    await loadHooks(lc, mockHookDeps(), hooksDir);
    // Exact counts — `>=` would hide accidental double-registration.
    expect(lc.count("pre_turn")).toBe(2); // init-scratch, apply-skills
    expect(lc.count("pre_tool")).toBe(2); // budget-guard, foundation-citation-guard
    expect(lc.count("post_tool")).toBe(3); // tag-maturity, anti-fabrication, source-cache
    expect(lc.count("pre_compact")).toBe(1); // compact-window
    expect(lc.count("post_turn")).toBe(1); // redact-secrets
    // Sanity sum: 2 + 2 + 3 + 1 + 1 = 9 hooks total.
    const totalRegistered = (
      ["pre_turn", "pre_tool", "post_tool", "pre_compact", "post_turn"] as const
    ).reduce((sum, p) => sum + lc.count(p), 0);
    expect(totalRegistered).toBe(9);
  });

  it("each YAML file's `name` field is non-empty", async () => {
    const yamlEntries = (await readdir(hooksDir)).filter((f) => f.endsWith(".yaml"));
    for (const file of yamlEntries) {
      const raw = await readFile(resolve(hooksDir, file), "utf8");
      const parsed = parseYaml(raw) as { name: string };
      expect(parsed.name, `${file} has empty name`).toBeTruthy();
    }
  });
});

describe("hook YAML/registrar parity", () => {
  it("every YAML's lifecycle field matches where its registrar actually wires the handler", async () => {
    const yamlEntries = (await readdir(hooksDir)).filter((f) => f.endsWith(".yaml"));

    // Build a map of name → declared lifecycle from each YAML file.
    const declared = new Map<string, string>();
    for (const file of yamlEntries) {
      const raw = await readFile(resolve(hooksDir, file), "utf8");
      const parsed = parseYaml(raw) as { name?: string; lifecycle?: string; enabled?: boolean };
      if (parsed.enabled === false) continue;
      if (parsed.name && parsed.lifecycle) {
        declared.set(parsed.name, parsed.lifecycle);
      }
    }

    // Run the loader, then introspect the lifecycle to discover where
    // each registered hook actually landed.
    const lc = new Lifecycle();
    await loadHooks(lc, mockHookDeps(), hooksDir);

    const points = ["pre_turn", "pre_tool", "post_tool", "pre_compact", "post_turn"] as const;
    const actual = new Map<string, string>();
    for (const point of points) {
      for (const name of lc.hookNames(point)) {
        actual.set(name, point);
      }
    }

    // Each declared YAML must match its registrar's actual point. A
    // mismatch means the YAML is lying about where the hook fires —
    // future drift fails CI.
    for (const [name, declaredPoint] of declared) {
      const actualPoint = actual.get(name);
      expect(actualPoint, `hook ${name}: YAML declares ${declaredPoint}`).toBe(declaredPoint);
    }
  });
});
