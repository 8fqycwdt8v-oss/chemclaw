// Phase 1A coverage test — guarantees that every YAML hook descriptor in
// `hooks/` resolves to a registered built-in handler, and that the 27 known
// hook implementations register at the right lifecycle points.
//
// Phase 4B added the no-op session-events hook (10 total).
// Phase 6 added the no-op permission hook on permission_request (11 total).
// Cluster F added 9 lifecycle-telemetry stubs for the previously
// dispatched-but-unimplemented points (20 total).
// E2B sandbox-reuse change added session-sandbox-close on session_end
// (21 total; session_end now has 2 handlers).
// Review §3.8 added detect-mcp-leakage on post_tool (22 total; post_tool
// now has 4 handlers).
// Adaptive-replanning Phase A1 added loop-detector on pre_tool (23 total).
// Review 2026-05-10 §2.6 added fact-id-consistency-guard on post_tool
// (24 total; post_tool now has 5 handlers).
// ADR 012 Phase 1 added wiki-human-block-guard on pre_tool (25 total).
// Gap-plan H0.9 added scheduled-substance-gate on pre_tool (26 total;
// pre_tool now has 5 handlers).
// Tranche 1 / Task G added redact-tool-output on post_tool (27 total;
// post_tool now has 6 handlers).
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

  it("registers all 27 known hook implementations at the right points", async () => {
    const lc = new Lifecycle();
    await loadHooks(lc, mockHookDeps(), hooksDir);
    // Exact counts — `>=` would hide accidental double-registration.
    expect(lc.count("pre_turn")).toBe(2); // init-scratch, apply-skills
    expect(lc.count("pre_tool")).toBe(5); // budget-guard, foundation-citation-guard, loop-detector, wiki-human-block-guard, scheduled-substance-gate
    expect(lc.count("post_tool")).toBe(6); // tag-maturity, anti-fabrication, source-cache, detect-mcp-leakage, fact-id-consistency-guard, redact-tool-output
    expect(lc.count("pre_compact")).toBe(1); // compact-window
    expect(lc.count("post_turn")).toBe(1); // redact-secrets
    expect(lc.count("session_start")).toBe(1); // session-events (Phase 4B)
    expect(lc.count("permission_request")).toBe(1); // permission (Phase 6)
    // Cluster F: lifecycle-telemetry stubs (one each).
    // session_end has 2: telemetry stub + session-sandbox-close.
    expect(lc.count("session_end")).toBe(2);
    expect(lc.count("user_prompt_submit")).toBe(1);
    expect(lc.count("post_tool_failure")).toBe(1);
    expect(lc.count("post_tool_batch")).toBe(1);
    expect(lc.count("subagent_start")).toBe(1);
    expect(lc.count("subagent_stop")).toBe(1);
    expect(lc.count("task_created")).toBe(1);
    expect(lc.count("task_completed")).toBe(1);
    expect(lc.count("post_compact")).toBe(1);
    // Sanity sum: 2 + 5 + 6 + 1 + 1 + 1 + 1 + 9 + 1 = 27 hooks total.
    const totalRegistered = (
      [
        "pre_turn",
        "pre_tool",
        "post_tool",
        "pre_compact",
        "post_compact",
        "post_turn",
        "session_start",
        "session_end",
        "user_prompt_submit",
        "post_tool_failure",
        "post_tool_batch",
        "permission_request",
        "subagent_start",
        "subagent_stop",
        "task_created",
        "task_completed",
      ] as const
    ).reduce((sum, p) => sum + lc.count(p), 0);
    expect(totalRegistered).toBe(27);
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

    // Cover the 5 core points + every extended point that has a built-in
    // registrar (session_start for session-events, permission_request for
    // the permission hook). Adding a hook that fires at a new extended
    // point requires bumping this list — that's the audit-friendly trade.
    const points = [
      "pre_turn",
      "pre_tool",
      "post_tool",
      "pre_compact",
      "post_compact",
      "post_turn",
      "session_start",
      "session_end",
      "user_prompt_submit",
      "post_tool_failure",
      "post_tool_batch",
      "permission_request",
      "subagent_start",
      "subagent_stop",
      "task_created",
      "task_completed",
    ] as const;
    // Some registrars (e.g. tool-invocation-emitter) attach the same hook
    // name at MORE than one lifecycle point — the YAML declares the
    // primary point and the registrar fans out internally. Track the full
    // set of actual points per name so the assertion below tolerates
    // multi-point registrations as long as the YAML's declared point is
    // one of them.
    const actual = new Map<string, Set<string>>();
    for (const point of points) {
      for (const name of lc.hookNames(point)) {
        let set = actual.get(name);
        if (!set) {
          set = new Set<string>();
          actual.set(name, set);
        }
        set.add(point);
      }
    }

    // Each declared YAML's lifecycle must be among the points where its
    // registrar actually wires the handler. A YAML hook whose registrar
    // doesn't attach at the declared point indicates drift.
    //
    // Hooks that didn't register at all in the test context (e.g. a
    // `condition: { default: false }` block that short-circuited with no
    // env-var override) are tolerated here — the "no missing registrar"
    // test above already guards the registrar-existence invariant; this
    // test focuses strictly on declared-point matching.
    for (const [name, declaredPoint] of declared) {
      const actualPoints = actual.get(name);
      if (!actualPoints) continue;
      expect(
        [...actualPoints],
        `hook ${name}: YAML declares ${declaredPoint} but registrar wires ${[...actualPoints].join(", ")}`,
      ).toContain(declaredPoint);
    }
  });
});
