// Tests for the slash-command parser and dispatcher.

import { describe, it, expect } from "vitest";
import {
  parseSlash,
  parseFeedbackArgs,
  shortCircuitResponse,
  HELP_TEXT,
} from "../../src/core/slash.js";

// ---------------------------------------------------------------------------
// parseSlash
// ---------------------------------------------------------------------------

describe("parseSlash — non-slash input", () => {
  it("returns empty verb and isStreamable=true for plain text", () => {
    const r = parseSlash("hello world");
    expect(r.verb).toBe("");
    expect(r.isStreamable).toBe(true);
    expect(r.remainingText).toBe("hello world");
  });

  it("handles leading whitespace before non-slash text", () => {
    const r = parseSlash("  hello");
    expect(r.verb).toBe("");
    expect(r.isStreamable).toBe(true);
  });
});

describe("parseSlash — known short-circuit verbs", () => {
  it("/help parses correctly with isStreamable=false", () => {
    const r = parseSlash("/help");
    expect(r.verb).toBe("help");
    expect(r.args).toBe("");
    expect(r.isStreamable).toBe(false);
  });

  it("/skills parses correctly with isStreamable=false", () => {
    const r = parseSlash("/skills");
    expect(r.verb).toBe("skills");
    expect(r.isStreamable).toBe(false);
  });

  it("/check parses correctly with isStreamable=false", () => {
    const r = parseSlash("/check");
    expect(r.verb).toBe("check");
    expect(r.isStreamable).toBe(false);
  });

  it("/learn parses correctly with isStreamable=false", () => {
    const r = parseSlash("/learn");
    expect(r.verb).toBe("learn");
    expect(r.isStreamable).toBe(false);
  });

  it("/feedback with args parses correctly", () => {
    const r = parseSlash('/feedback up "great answer"');
    expect(r.verb).toBe("feedback");
    expect(r.args).toBe('up "great answer"');
    expect(r.isStreamable).toBe(false);
  });

  it("/feedback down without quotes parses correctly", () => {
    const r = parseSlash("/feedback down missed the point");
    expect(r.verb).toBe("feedback");
    expect(r.args).toBe("down missed the point");
    expect(r.isStreamable).toBe(false);
  });
});

describe("parseSlash — streamable verbs", () => {
  it("/plan returns isStreamable=true", () => {
    const r = parseSlash("/plan optimize the route");
    expect(r.verb).toBe("plan");
    expect(r.args).toBe("optimize the route");
    expect(r.isStreamable).toBe(true);
  });

  it("/dr returns isStreamable=true", () => {
    const r = parseSlash("/dr what yields are best for amide coupling?");
    expect(r.verb).toBe("dr");
    expect(r.args).toBe("what yields are best for amide coupling?");
    expect(r.isStreamable).toBe(true);
  });

  it("/forge returns isStreamable=true with description as args", () => {
    const r = parseSlash("/forge compute molecular weight from SMILES");
    expect(r.verb).toBe("forge");
    expect(r.args).toBe("compute molecular weight from SMILES");
    expect(r.isStreamable).toBe(true);
  });

  it("/forge with no description parses correctly (empty args)", () => {
    const r = parseSlash("/forge");
    expect(r.verb).toBe("forge");
    expect(r.args).toBe("");
    expect(r.isStreamable).toBe(true);
  });
});

describe("parseSlash — unknown verbs", () => {
  it("returns the verb and isStreamable=false for unknown /foo", () => {
    const r = parseSlash("/foo some args");
    expect(r.verb).toBe("foo");
    expect(r.isStreamable).toBe(false);
    expect(r.args).toBe("some args");
  });

  it("handles unknown verb with no args", () => {
    const r = parseSlash("/baz");
    expect(r.verb).toBe("baz");
    expect(r.args).toBe("");
    expect(r.isStreamable).toBe(false);
  });
});

describe("parseSlash — verb normalization", () => {
  it("lowercases the verb", () => {
    const r = parseSlash("/HELP");
    expect(r.verb).toBe("help");
  });
});

// ---------------------------------------------------------------------------
// parseFeedbackArgs
// ---------------------------------------------------------------------------

describe("parseFeedbackArgs", () => {
  it('parses up signal with quoted reason', () => {
    const r = parseFeedbackArgs('up "excellent insight"');
    expect(r).not.toBeNull();
    expect(r!.signal).toBe("thumbs_up");
    expect(r!.reason).toBe("excellent insight");
  });

  it("parses down signal with unquoted reason", () => {
    const r = parseFeedbackArgs("down missed the impurity peak");
    expect(r).not.toBeNull();
    expect(r!.signal).toBe("thumbs_down");
    expect(r!.reason).toBe("missed the impurity peak");
  });

  it("parses signal with no reason", () => {
    const r = parseFeedbackArgs("up");
    expect(r).not.toBeNull();
    expect(r!.signal).toBe("thumbs_up");
    expect(r!.reason).toBe("");
  });

  it("returns null for empty args", () => {
    expect(parseFeedbackArgs("")).toBeNull();
  });

  it("returns null for invalid signal token", () => {
    expect(parseFeedbackArgs('sideways "no reason"')).toBeNull();
  });

  it('parses single-quoted reason', () => {
    const r = parseFeedbackArgs("down 'wrong compound'");
    expect(r).not.toBeNull();
    expect(r!.reason).toBe("wrong compound");
  });
});

// ---------------------------------------------------------------------------
// shortCircuitResponse
// ---------------------------------------------------------------------------

describe("shortCircuitResponse", () => {
  it("/help returns the HELP_TEXT constant", () => {
    expect(shortCircuitResponse("help")).toBe(HELP_TEXT);
  });

  it("/skills returns a usage message", () => {
    const r = shortCircuitResponse("skills");
    expect(r).toContain("skills");
  });

  it("/check returns a confidence ensemble message", () => {
    const r = shortCircuitResponse("check");
    expect(r).toContain("confidence");
  });

  it("/learn returns a skill induction message", () => {
    const r = shortCircuitResponse("learn");
    expect(r).toContain("skill");
  });

  it("returns null for feedback (needs DB work)", () => {
    expect(shortCircuitResponse("feedback")).toBeNull();
  });
});

describe("HELP_TEXT — /forge verb listed", () => {
  it("includes /forge in the HELP_TEXT", () => {
    expect(HELP_TEXT).toContain("/forge");
  });
});
