// Unit tests for mark_research_done — input schema, markdown assembly,
// slug derivation. The DB persistence path is covered by integration tests.

import { describe, expect, it } from "vitest";
import {
  MarkResearchDoneInput,
  _buildMarkdownForTests,
  _slugifyForTests,
} from "../../src/tools/mark-research-done.js";

describe("MarkResearchDoneInput", () => {
  it("accepts a minimal valid report", () => {
    const v = MarkResearchDoneInput.parse({
      title: "Pd catalyst review",
      executive_summary: "Pd(PPh3)4 is the default; Pd(dppf)Cl2 for electron-poor.",
      sections: [{ heading: "Overview", body_markdown: "x" }],
    });
    expect(v.sections.length).toBe(1);
    expect(v.open_questions).toEqual([]);
  });

  it("rejects empty sections array", () => {
    expect(() =>
      MarkResearchDoneInput.parse({
        title: "t",
        executive_summary: "s",
        sections: [],
      }),
    ).toThrow();
  });

  it("caps section count", () => {
    const many = Array.from({ length: 31 }, () => ({
      heading: "h",
      body_markdown: "b",
    }));
    expect(() =>
      MarkResearchDoneInput.parse({
        title: "t",
        executive_summary: "s",
        sections: many,
      }),
    ).toThrow();
  });
});

describe("_slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(_slugifyForTests("Pd Catalyst Review Q1 2026")).toBe(
      "pd-catalyst-review-q1-2026",
    );
  });

  it("strips leading/trailing punctuation", () => {
    expect(_slugifyForTests("!!! hello ???")).toBe("hello");
  });

  it("falls back to 'report' for all-symbol titles", () => {
    expect(_slugifyForTests("!!!")).toBe("report");
    expect(_slugifyForTests("")).toBe("report");
  });

  it("caps length at 60 chars", () => {
    const long = _slugifyForTests("a".repeat(200));
    expect(long.length).toBeLessThanOrEqual(60);
  });
});

describe("_buildMarkdown", () => {
  it("includes executive summary + sections", () => {
    const md = _buildMarkdownForTests({
      title: "T",
      executive_summary: "ES",
      sections: [{ heading: "S1", body_markdown: "B1" }],
      open_questions: [],
      contradictions: [],
      citations: [],
    });
    expect(md.startsWith("# T\n")).toBe(true);
    expect(md.includes("## Executive summary\n\nES")).toBe(true);
    expect(md.includes("## S1\n\nB1")).toBe(true);
  });

  it("adds a Contradictions section when non-empty", () => {
    const md = _buildMarkdownForTests({
      title: "T",
      executive_summary: "ES",
      sections: [{ heading: "S", body_markdown: "B" }],
      open_questions: [],
      contradictions: ["yield 73% vs 58% under same conditions"],
      citations: [],
    });
    expect(md.includes("## Contradictions")).toBe(true);
    expect(md.includes("yield 73% vs 58%")).toBe(true);
  });

  it("omits Contradictions section when empty", () => {
    const md = _buildMarkdownForTests({
      title: "T",
      executive_summary: "ES",
      sections: [{ heading: "S", body_markdown: "B" }],
      open_questions: [],
      contradictions: [],
      citations: [],
    });
    expect(md.includes("## Contradictions")).toBe(false);
  });

  it("renders citations with optional detail", () => {
    const md = _buildMarkdownForTests({
      title: "T",
      executive_summary: "ES",
      sections: [{ heading: "S", body_markdown: "B" }],
      open_questions: [],
      contradictions: [],
      citations: [
        { ref: "[exp:ELN-1]" },
        { ref: "[doc:a1b2c3d4]", detail: "Method validation v2.1" },
      ],
    });
    expect(md.includes("- [exp:ELN-1]\n")).toBe(true);
    expect(md.includes("- [doc:a1b2c3d4] — Method validation v2.1")).toBe(true);
  });
});
