// Tests for scripts/forged-tool-ci-check.ts — CI gate (Phase D.5).
// Uses the in-process SQLite-like fixture; zero Postgres.

import { describe, it, expect } from "vitest";
import {
  auditFixture,
  makeToolRow,
  makeTestRow,
  type CiFixture,
} from "../../../scripts/forged-tool-ci-check.js";

// ---------------------------------------------------------------------------

describe("auditFixture — passing cases", () => {
  it("passes when there are no forged tools", () => {
    const fixture: CiFixture = { tools: [], tests: [] };
    expect(auditFixture(fixture)).toEqual([]);
  });

  it("passes when a forged tool has ≥3 functional + ≥1 contract tests", () => {
    const tool = makeToolRow("good_tool");
    const tests = [
      makeTestRow(tool.id, "functional"),
      makeTestRow(tool.id, "functional"),
      makeTestRow(tool.id, "functional"),
      makeTestRow(tool.id, "contract"),
    ];
    expect(auditFixture({ tools: [tool], tests })).toEqual([]);
  });

  it("ignores non-forged-tool skill_library rows", () => {
    const skill = { id: "abc", name: "some_skill", kind: "prompt" };
    const fixture: CiFixture = { tools: [skill], tests: [] };
    expect(auditFixture(fixture)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("auditFixture — violation cases", () => {
  it("flags a tool with 0 tests", () => {
    const tool = makeToolRow("empty_tool");
    const violations = auditFixture({ tools: [tool], tests: [] });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.tool_name).toBe("empty_tool");
    expect(violations[0]!.functional_count).toBe(0);
    expect(violations[0]!.contract_count).toBe(0);
  });

  it("flags a tool with 2 functional tests but 0 contract tests", () => {
    const tool = makeToolRow("partial_tool");
    const tests = [
      makeTestRow(tool.id, "functional"),
      makeTestRow(tool.id, "functional"),
    ];
    const violations = auditFixture({ tools: [tool], tests });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.functional_count).toBe(2);
    expect(violations[0]!.contract_count).toBe(0);
  });

  it("flags a tool with 3 functional tests but 0 contract tests", () => {
    const tool = makeToolRow("no_contract_tool");
    const tests = [
      makeTestRow(tool.id, "functional"),
      makeTestRow(tool.id, "functional"),
      makeTestRow(tool.id, "functional"),
    ];
    const violations = auditFixture({ tools: [tool], tests });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.contract_count).toBe(0);
  });

  it("reports multiple violations across multiple tools", () => {
    const tool1 = makeToolRow("tool_a");
    const tool2 = makeToolRow("tool_b");
    // tool1: only 1 functional; tool2: only 1 contract, no functional.
    const tests = [
      makeTestRow(tool1.id, "functional"),
      makeTestRow(tool2.id, "contract"),
    ];
    const violations = auditFixture({ tools: [tool1, tool2], tests });
    expect(violations).toHaveLength(2);
  });

  it("violation message contains tool name and counts", () => {
    const tool = makeToolRow("bad_tool");
    const [violation] = auditFixture({ tools: [tool], tests: [] });
    expect(violation!.message).toContain("bad_tool");
    expect(violation!.message).toContain("0/3");
    expect(violation!.message).toContain("0/1");
  });
});
