// Tests for /eval slash verb — Phase E.

import { describe, it, expect } from "vitest";
import { parseSlash, parseEvalArgs } from "../../src/core/slash.js";

describe("parseSlash — /eval verb", () => {
  it("recognises /eval as a short-circuit verb", () => {
    const result = parseSlash("/eval golden");
    expect(result.verb).toBe("eval");
    expect(result.isStreamable).toBe(false);
    expect(result.args).toBe("golden");
  });

  it("recognises /eval shadow <name>", () => {
    const result = parseSlash("/eval shadow agent.system");
    expect(result.verb).toBe("eval");
    expect(result.args).toBe("shadow agent.system");
  });

  it("treats bare /eval as short-circuit (no args)", () => {
    const result = parseSlash("/eval");
    expect(result.verb).toBe("eval");
    expect(result.isStreamable).toBe(false);
  });
});

describe("parseEvalArgs", () => {
  it("parses 'golden' correctly", () => {
    const result = parseEvalArgs("golden");
    expect(result.subVerb).toBe("golden");
  });

  it("parses 'GOLDEN' case-insensitively", () => {
    const result = parseEvalArgs("GOLDEN");
    expect(result.subVerb).toBe("golden");
  });

  it("parses 'shadow agent.system' correctly", () => {
    const result = parseEvalArgs("shadow agent.system");
    expect(result.subVerb).toBe("shadow");
    if (result.subVerb === "shadow") {
      expect(result.promptName).toBe("agent.system");
    }
  });

  it("parses 'shadow agent.deep_research_mode.v1' with dots in name", () => {
    const result = parseEvalArgs("shadow agent.deep_research_mode.v1");
    expect(result.subVerb).toBe("shadow");
    if (result.subVerb === "shadow") {
      expect(result.promptName).toBe("agent.deep_research_mode.v1");
    }
  });

  it("returns unknown for empty args", () => {
    const result = parseEvalArgs("");
    expect(result.subVerb).toBe("unknown");
  });

  it("returns unknown for 'shadow' without a prompt name", () => {
    const result = parseEvalArgs("shadow");
    expect(result.subVerb).toBe("unknown");
  });

  it("returns unknown for unrecognised sub-command", () => {
    const result = parseEvalArgs("something_else");
    expect(result.subVerb).toBe("unknown");
  });
});
