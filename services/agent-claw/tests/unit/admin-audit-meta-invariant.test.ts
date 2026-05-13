// Meta-test: every state-mutating handler in services/agent-claw/src/routes/admin/
// must call appendAudit at least once.
//
// BACKLOG'd test gap: per-route hand-rolled tests already check the audit
// path for individual endpoints (admin-routes.test.ts, admin-config-routes.test.ts).
// This file adds a CATCH-ALL: when someone introduces a new admin endpoint
// or a new mutation method on an existing one, this test fails if they
// forgot to wire appendAudit. Without it, the audit invariant is held by
// memory of the original author and is easy to silently violate.
//
// Approach: static analysis of the source files. No Fastify, no Pool, no
// runtime — just AST-style text inspection. We count the number of
// app.{post,put,patch,delete} registrations per file and the number of
// appendAudit(...) call sites, and assert the latter is greater than or
// equal to the former.
//
// Caveats and heuristics:
//   - A single handler may legitimately call appendAudit multiple times
//     (e.g., admin-permissions exposes one route that audits per item),
//     so the assertion is `audit calls >= mutation registrations`, not
//     equality.
//   - Some handlers SKIP audit on idempotent no-ops (granted=false,
//     deleted=false). This test cannot detect that gap; the per-route
//     unit tests (admin-routes.test.ts, admin-config-routes.test.ts)
//     remain the source of truth for those branch-level invariants.
//   - Files this test scans are mutation-bearing only. audit-log.ts is
//     the helper itself; index.ts is the registry; admin-audit.ts only
//     exposes a GET; all three are excluded.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const adminRoutesDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "routes",
  "admin",
);

// Files in routes/admin that DON'T register state-mutating handlers and
// therefore aren't expected to call appendAudit. Anything else in the
// directory MUST come up clean in the asserts below.
const NON_MUTATING_FILES = new Set([
  "audit-log.ts",   // helper module — defines appendAudit itself
  "index.ts",       // route registrar aggregation
  "admin-audit.ts", // exposes only GET /api/admin/audit (read-only)
]);

const MUTATION_VERBS = ["post", "put", "patch", "delete"] as const;

interface FileMetrics {
  file: string;
  registrations: number;
  auditCalls: number;
  registrationLines: number[];
}

function analyseFile(absPath: string): FileMetrics {
  const src = readFileSync(absPath, "utf8");
  const lines = src.split("\n");
  let registrations = 0;
  const registrationLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const verb of MUTATION_VERBS) {
      // Match `app.post(`, `app.put(`, etc. — Fastify route registrations.
      // Anchored on the actual decorator name `app` (every admin route in
      // this directory uses `app.<verb>`; grep confirms zero `server.` /
      // `router.` call sites). Anchoring eliminates false positives from
      // unrelated `*.delete(` / `*.post(` patterns that may land here
      // later (e.g. `pool.delete(key)`, `array.post('x')` typo). If a
      // future Fastify rename lands, broaden the alternation here.
      const re = new RegExp(`\\bapp\\.${verb}\\s*\\(`);
      if (re.test(line)) {
        registrations++;
        registrationLines.push(i + 1);
      }
    }
  }
  // Count appendAudit call sites — text-grep is sufficient because the
  // helper has a single name and is always invoked as `await appendAudit(`
  // or `appendAudit(`. Imports don't count as call sites.
  const auditMatches = src.matchAll(/\bappendAudit\s*\(/g);
  let auditCalls = 0;
  for (const _ of auditMatches) auditCalls++;
  return {
    file: absPath.split("/").pop() ?? absPath,
    registrations,
    auditCalls,
    registrationLines,
  };
}

describe("admin route audit-log invariant (meta-test)", () => {
  const files = readdirSync(adminRoutesDir).filter(
    (f) => f.endsWith(".ts") && !NON_MUTATING_FILES.has(f),
  );

  it("the directory contains at least the expected mutation-bearing files", () => {
    // Trip if a future refactor moves all admin mutations elsewhere — at
    // which point this test needs to follow them, not silently green.
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files).toContain("admin-users.ts");
    expect(files).toContain("admin-config.ts");
    expect(files).toContain("admin-flags.ts");
    expect(files).toContain("admin-permissions.ts");
  });

  for (const f of files) {
    it(`${f} has appendAudit calls >= mutation registrations`, () => {
      const m = analyseFile(resolve(adminRoutesDir, f));
      expect(
        m.auditCalls,
        `expected ${f} to have at least ${m.registrations} appendAudit ` +
          `call(s) (one per mutation registration), found ${m.auditCalls}. ` +
          `Mutation registrations are at lines ${m.registrationLines.join(", ")}.`,
      ).toBeGreaterThanOrEqual(m.registrations);
    });
  }

  it("at least one mutation-bearing file is actually exercised — sanity check", () => {
    // If the regexes above silently match zero registrations across the
    // whole directory, the assertions above all pass vacuously. This
    // sanity check trips when the real signal is dead.
    const totals = files
      .map((f) => analyseFile(resolve(adminRoutesDir, f)))
      .reduce(
        (acc, m) => ({
          registrations: acc.registrations + m.registrations,
          auditCalls: acc.auditCalls + m.auditCalls,
        }),
        { registrations: 0, auditCalls: 0 },
      );
    expect(totals.registrations).toBeGreaterThan(0);
    expect(totals.auditCalls).toBeGreaterThan(0);
  });
});
