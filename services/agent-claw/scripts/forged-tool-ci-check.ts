#!/usr/bin/env tsx
/**
 * forged-tool-ci-check — Phase D.5 CI gate.
 *
 * Reads forged tools from an in-process SQLite fixture (or live Postgres when
 * DATABASE_URL is set) and asserts that every `kind='forged_tool'` row has:
 *   - ≥3 `functional` test cases in forged_tool_tests
 *   - ≥1 `contract`   test case  in forged_tool_tests
 *
 * Exits 1 if any tool is missing the required tests.
 * Exits 0 when all tools pass (or when no forged tools exist).
 *
 * For tests, uses the in-process SQLite fixture exported from this module.
 */

import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Minimal in-process data store (SQLite-like fixture for CI).
// ---------------------------------------------------------------------------

/** A row from skill_library for CI purposes. */
export interface SkillLibraryRow {
  id: string;
  name: string;
  kind: string;
}

/** A row from forged_tool_tests for CI purposes. */
export interface ForgedToolTestRow {
  id: string;
  forged_tool_id: string;
  kind: "functional" | "contract" | "property";
}

export interface CiFixture {
  tools: SkillLibraryRow[];
  tests: ForgedToolTestRow[];
}

// ---------------------------------------------------------------------------
// Audit logic (exported for tests)
// ---------------------------------------------------------------------------

export interface CiViolation {
  tool_id: string;
  tool_name: string;
  functional_count: number;
  contract_count: number;
  message: string;
}

/**
 * Audit the in-process fixture and return any violations.
 * A violation = forged tool with < 3 functional tests or < 1 contract test.
 */
export function auditFixture(fixture: CiFixture): CiViolation[] {
  const violations: CiViolation[] = [];

  for (const tool of fixture.tools) {
    if (tool.kind !== "forged_tool") continue;

    const toolTests = fixture.tests.filter((t) => t.forged_tool_id === tool.id);
    const functionalCount = toolTests.filter((t) => t.kind === "functional").length;
    const contractCount = toolTests.filter((t) => t.kind === "contract").length;

    if (functionalCount < 3 || contractCount < 1) {
      violations.push({
        tool_id: tool.id,
        tool_name: tool.name,
        functional_count: functionalCount,
        contract_count: contractCount,
        message:
          `Tool '${tool.name}' (${tool.id}): ` +
          `${functionalCount}/3 functional tests, ${contractCount}/1 contract tests.`,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Helpers for tests — build fixture entries easily.
// ---------------------------------------------------------------------------

export function makeToolRow(name: string): SkillLibraryRow {
  return { id: randomUUID(), name, kind: "forged_tool" };
}

export function makeTestRow(
  forged_tool_id: string,
  kind: "functional" | "contract" | "property" = "functional",
): ForgedToolTestRow {
  return { id: randomUUID(), forged_tool_id, kind };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // In CI, if DATABASE_URL is set, connect to Postgres.
  // Otherwise run against an empty fixture (no forged tools → always passes).

  const databaseUrl = process.env["DATABASE_URL"];

  let fixture: CiFixture;

  if (databaseUrl) {
    // Dynamic import so the module is usable without pg in unit tests.
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: databaseUrl });

    try {
      const toolsResult = await pool.query<SkillLibraryRow>(
        `SELECT id::text, name, kind FROM skill_library WHERE kind = 'forged_tool'`,
      );
      const testsResult = await pool.query<ForgedToolTestRow>(
        `SELECT id::text, forged_tool_id::text, kind
           FROM forged_tool_tests
          WHERE forged_tool_id IN (
            SELECT id FROM skill_library WHERE kind = 'forged_tool'
          )`,
      );
      fixture = { tools: toolsResult.rows, tests: testsResult.rows };
    } finally {
      await pool.end();
    }
  } else {
    // No DB — treat as empty fixture.
    fixture = { tools: [], tests: [] };
    console.log("forged-tool-ci-check: DATABASE_URL not set; running against empty fixture (pass).");
  }

  const violations = auditFixture(fixture);

  if (violations.length === 0) {
    console.log(
      `forged-tool-ci-check: all ${fixture.tools.filter((t) => t.kind === "forged_tool").length} forged tool(s) pass the test-count gate.`,
    );
    process.exit(0);
  } else {
    console.error(`forged-tool-ci-check: ${violations.length} violation(s) found:`);
    for (const v of violations) {
      console.error(`  [FAIL] ${v.message}`);
    }
    console.error(
      "Each forged tool MUST have ≥3 functional tests and ≥1 contract test in forged_tool_tests.",
    );
    process.exit(1);
  }
}

// Only run main when executed as a CLI script.
if (process.argv[1] && process.argv[1].endsWith("forged-tool-ci-check.ts")) {
  main().catch((err: unknown) => {
    console.error("forged-tool-ci-check: fatal error:", err);
    process.exit(1);
  });
}
