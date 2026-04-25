// Tests for /forged slash verb parsing (Phase D.5).

import { describe, it, expect } from "vitest";
import { parseSlash, parseForgedArgs, shortCircuitResponse } from "../../src/core/slash.js";

describe("parseSlash — /forged verb", () => {
  it("parses /forged list as short-circuit", () => {
    const result = parseSlash("/forged list");
    expect(result.verb).toBe("forged");
    expect(result.isStreamable).toBe(false);
    expect(result.args).toBe("list");
  });

  it("parses /forged show <id> as short-circuit", () => {
    const result = parseSlash("/forged show abc-123");
    expect(result.verb).toBe("forged");
    expect(result.isStreamable).toBe(false);
    expect(result.args).toBe("show abc-123");
  });

  it("parses /forged disable as short-circuit", () => {
    const result = parseSlash("/forged disable abc-123 outdated");
    expect(result.verb).toBe("forged");
    expect(result.isStreamable).toBe(false);
  });

  it("short-circuit response for forged verb contains usage hint", () => {
    const resp = shortCircuitResponse("forged");
    expect(resp).not.toBeNull();
    expect(resp).toContain("/forged list");
    expect(resp).toContain("/forged show");
    expect(resp).toContain("/forged disable");
  });
});

describe("parseForgedArgs", () => {
  it("returns list when no args provided", () => {
    expect(parseForgedArgs("")).toEqual({ subVerb: "list" });
  });

  it("returns list for 'list' arg", () => {
    expect(parseForgedArgs("list")).toEqual({ subVerb: "list" });
  });

  it("parses show with id", () => {
    const result = parseForgedArgs("show tool-uuid-123");
    expect(result).toEqual({ subVerb: "show", id: "tool-uuid-123" });
  });

  it("parses disable with id and reason", () => {
    const result = parseForgedArgs("disable tool-uuid outdated implementation");
    expect(result).toEqual({
      subVerb: "disable",
      id: "tool-uuid",
      reason: "outdated implementation",
    });
  });

  it("returns unknown for unrecognized sub-verb", () => {
    const result = parseForgedArgs("frobnicate foo");
    expect(result.subVerb).toBe("unknown");
  });

  it("returns unknown when show has no id", () => {
    const result = parseForgedArgs("show");
    expect(result.subVerb).toBe("unknown");
  });

  it("returns unknown when disable has no reason", () => {
    const result = parseForgedArgs("disable tool-uuid");
    expect(result.subVerb).toBe("unknown");
  });
});
