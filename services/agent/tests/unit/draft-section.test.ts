// Unit tests for draft_section — citation validation + format.

import { describe, expect, it } from "vitest";
import {
  DraftSectionInput,
  draftSection,
} from "../../src/tools/draft-section.js";

describe("DraftSectionInput", () => {
  it("accepts valid citation refs", () => {
    const v = DraftSectionInput.parse({
      heading: "Pd catalyst selection",
      evidence_refs: ["[exp:ELN-NCE001-0042]", "[proj:NCE-001]", "[doc:ab12cd34]"],
      body_markdown: "Pd(PPh3)4 gave 73% [exp:ELN-NCE001-0042] on the benchmark.",
    });
    expect(v.evidence_refs.length).toBe(3);
  });

  it("rejects unknown citation kinds", () => {
    expect(() =>
      DraftSectionInput.parse({
        heading: "h",
        evidence_refs: ["[random:x]"],
        body_markdown: "body",
      }),
    ).toThrow();
  });

  it("rejects empty headings and bodies", () => {
    expect(() =>
      DraftSectionInput.parse({
        heading: "",
        evidence_refs: [],
        body_markdown: "x",
      }),
    ).toThrow();
    expect(() =>
      DraftSectionInput.parse({
        heading: "h",
        evidence_refs: [],
        body_markdown: "",
      }),
    ).toThrow();
  });

  it("caps oversized body", () => {
    expect(() =>
      DraftSectionInput.parse({
        heading: "h",
        evidence_refs: [],
        body_markdown: "x".repeat(40_001),
      }),
    ).toThrow();
  });
});

describe("draftSection", () => {
  it("echoes the section with H2 heading and trims whitespace", () => {
    const out = draftSection({
      heading: "  Selectivity  ",
      evidence_refs: ["[exp:E-1]"],
      body_markdown: "  hello [exp:E-1]  ",
    });
    expect(out.section_markdown.startsWith("## Selectivity\n\nhello")).toBe(true);
    expect(out.section_markdown.endsWith("hello [exp:E-1]\n")).toBe(true);
  });

  it("detects used citations in the body", () => {
    const out = draftSection({
      heading: "h",
      evidence_refs: ["[exp:E-1]", "[proj:NCE-001]"],
      body_markdown: "see [exp:E-1] and [proj:NCE-001] and [doc:abc12345]",
    });
    expect(new Set(out.used_refs)).toEqual(
      new Set(["[exp:E-1]", "[proj:NCE-001]", "[doc:abc12345]"]),
    );
    // [doc:abc12345] was not declared — must surface.
    expect(out.undeclared_refs).toContain("[doc:abc12345]");
  });

  it("flags unsourced claims via the [unsourced] token", () => {
    const out = draftSection({
      heading: "h",
      evidence_refs: [],
      body_markdown: "this is [unsourced] and lacks evidence",
    });
    expect(out.has_unsourced_claims).toBe(true);
    // [unsourced] does not count as undeclared — it's the explicit opt-out.
    expect(out.undeclared_refs).not.toContain("[unsourced]");
  });

  it("has_unsourced_claims is false when no [unsourced] in body", () => {
    const out = draftSection({
      heading: "h",
      evidence_refs: ["[exp:E-1]"],
      body_markdown: "clean body with [exp:E-1]",
    });
    expect(out.has_unsourced_claims).toBe(false);
  });
});
