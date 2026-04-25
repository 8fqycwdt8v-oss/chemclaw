// Tests for buildDraftSectionTool + draftSection pure function.

import { describe, it, expect } from "vitest";
import { buildDraftSectionTool, draftSection } from "../../../src/tools/builtins/draft_section.js";
import { makeCtx } from "../../helpers/make-ctx.js";

describe("draftSection (pure function)", () => {
  it("returns a formatted section with heading prefix", () => {
    const result = draftSection({
      heading: "Background",
      evidence_refs: ["[exp:EXP-001]"],
      body_markdown: "Catalyst A gave 85% yield [exp:EXP-001].",
    });
    expect(result.section_markdown).toMatch(/^## Background\n\n/);
    expect(result.section_markdown).toContain("Catalyst A gave 85% yield");
  });

  it("reports used_refs that appear inline in the body", () => {
    const result = draftSection({
      heading: "Results",
      evidence_refs: ["[kg:fact-001]", "[rxn:RXN-002]"],
      body_markdown: "As shown [kg:fact-001] and [rxn:RXN-002].",
    });
    expect(result.used_refs).toContain("[kg:fact-001]");
    expect(result.used_refs).toContain("[rxn:RXN-002]");
  });

  it("flags undeclared_refs (used in body but not in evidence_refs)", () => {
    const result = draftSection({
      heading: "Discussion",
      evidence_refs: ["[exp:EXP-001]"],
      body_markdown: "See [exp:EXP-001] and also [doc:DOC-999].",
    });
    expect(result.undeclared_refs).toContain("[doc:DOC-999]");
    expect(result.undeclared_refs).not.toContain("[exp:EXP-001]");
  });

  it("marks has_unsourced_claims true when [unsourced] appears", () => {
    const result = draftSection({
      heading: "Speculation",
      evidence_refs: [],
      body_markdown: "This is speculative [unsourced].",
    });
    expect(result.has_unsourced_claims).toBe(true);
  });

  it("[unsourced] is NOT flagged as undeclared", () => {
    const result = draftSection({
      heading: "Estimate",
      evidence_refs: [],
      body_markdown: "Rough estimate [unsourced].",
    });
    expect(result.undeclared_refs).not.toContain("[unsourced]");
  });

  it("returns empty used_refs when body has no inline citations", () => {
    const result = draftSection({
      heading: "Intro",
      evidence_refs: ["[exp:EXP-001]"],
      body_markdown: "A simple introduction with no citations.",
    });
    expect(result.used_refs).toHaveLength(0);
  });
});

describe("buildDraftSectionTool", () => {
  it("executes via the tool interface (async wrapper)", async () => {
    const tool = buildDraftSectionTool();
    const ctx = makeCtx();
    const result = await tool.execute(ctx, {
      heading: "Yield Analysis",
      evidence_refs: ["[rxn:R-1]"],
      body_markdown: "Yield improved by 20% [rxn:R-1].",
    });
    expect(result.section_markdown).toContain("Yield Analysis");
    expect(result.used_refs).toContain("[rxn:R-1]");
  });

  it("inputSchema rejects missing heading", () => {
    const tool = buildDraftSectionTool();
    const r = tool.inputSchema.safeParse({
      evidence_refs: [],
      body_markdown: "Something",
    });
    expect(r.success).toBe(false);
  });

  it("inputSchema rejects citation ref with invalid format", () => {
    const tool = buildDraftSectionTool();
    const r = tool.inputSchema.safeParse({
      heading: "X",
      evidence_refs: ["[INVALID]"],
      body_markdown: "x",
    });
    expect(r.success).toBe(false);
  });
});
