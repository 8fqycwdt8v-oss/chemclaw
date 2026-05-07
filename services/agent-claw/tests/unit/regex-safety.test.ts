// Tests for the shared ReDoS-safety helper. Both admin-redaction and
// admin-permissions consume isPatternSafe; covering it here keeps the
// per-route tests focused on the route handler rather than the shape
// of the validator's reasons.

import { describe, it, expect } from "vitest";
import {
  findUnboundedQuantifier,
  isPatternSafe,
} from "../../src/security/regex-safety.js";

describe("findUnboundedQuantifier", () => {
  it("returns null for safe bounded patterns", () => {
    expect(findUnboundedQuantifier("[A-Za-z]{1,32}")).toBeNull();
    expect(findUnboundedQuantifier("foo|bar")).toBeNull();
    expect(findUnboundedQuantifier("\\d{4}-\\d{2}")).toBeNull();
    expect(findUnboundedQuantifier("a?b?c?")).toBeNull();
  });

  it("flags bare unbounded + and * quantifiers", () => {
    expect(findUnboundedQuantifier("a+")).toMatch(/unbounded quantifier '\+'/);
    expect(findUnboundedQuantifier(".*")).toMatch(/unbounded quantifier '\*'/);
    expect(findUnboundedQuantifier("[a-z]+")).toMatch(/unbounded quantifier '\+'/);
  });

  it("flags catastrophic-backtracking shapes", () => {
    expect(findUnboundedQuantifier("(a+)+$")).not.toBeNull();
    expect(findUnboundedQuantifier("(a|a)*")).not.toBeNull();
  });

  it("treats escaped + and * as literals", () => {
    expect(findUnboundedQuantifier("\\+\\*")).toBeNull();
  });

  it("treats + and * inside a character class as literals", () => {
    expect(findUnboundedQuantifier("[+*]{1,3}")).toBeNull();
  });

  it("flags open-ended {n,} quantifier", () => {
    expect(findUnboundedQuantifier("a{2,}")).toMatch(/open-ended quantifier/);
  });
});

describe("isPatternSafe", () => {
  it("accepts a typical email regex", () => {
    expect(isPatternSafe("[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,64}").ok).toBe(true);
  });

  it("rejects the textbook (a+)+ catastrophic backtracking shape", () => {
    const r = isPatternSafe("(a+)+$");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unbounded quantifier/);
  });

  it("rejects patterns longer than the default 200-char cap", () => {
    const r = isPatternSafe("a".repeat(201));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/length > 200/);
  });

  it("rejects syntactically invalid regexes at the admin boundary", () => {
    const r = isPatternSafe("[unterminated");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid regex/);
  });

  it("honours a caller-supplied maxLength", () => {
    expect(isPatternSafe("a".repeat(50), 32).ok).toBe(false);
    expect(isPatternSafe("a".repeat(20), 32).ok).toBe(true);
  });
});
