// draft_section — Phase B.2 builtin.
//
// Pure server-side composition: takes heading + evidence refs + body markdown,
// validates inline citation syntax, and returns a formatted section string.
// No DB, no MCP, no seenFactIds — citation refs are syntactic tokens, not UUIDs.

import { z } from "zod";
import { defineTool } from "../tool.js";

// ---------- Schemas ----------------------------------------------------------

const CitationRef = z
  .string()
  .min(3)
  .max(300)
  .regex(
    /^\[(exp|rxn|proj|doc|kg|unsourced)(:[^\]]{1,256})?\]$/,
    "citation must be one of [exp:...] [rxn:...] [proj:...] [doc:...] [kg:...] or [unsourced]",
  );

export const DraftSectionIn = z.object({
  heading: z.string().min(1).max(400),
  evidence_refs: z.array(CitationRef).max(200),
  body_markdown: z.string().min(1).max(40_000),
});
export type DraftSectionInput = z.infer<typeof DraftSectionIn>;

export const DraftSectionOut = z.object({
  section_markdown: z.string(),
  declared_refs: z.array(z.string()),
  used_refs: z.array(z.string()),
  undeclared_refs: z.array(z.string()),
  has_unsourced_claims: z.boolean(),
});
export type DraftSectionOutput = z.infer<typeof DraftSectionOut>;

// ---------- Regex (bounded — no ReDoS surface) --------------------------------

// Each token is bounded: kind part is one of a fixed enum (max 10 chars),
// value part is limited to 256 chars. The overall pattern is safe.
const _INLINE_CITATION = /\[(?:exp|rxn|proj|doc|kg|unsourced)(?::[^\]]{1,256})?\]/g;

// ---------- Pure function (also exported for unit tests) ---------------------

export function draftSection(input: z.infer<typeof DraftSectionIn>): DraftSectionOutput {
  const used = new Set<string>();
  let m: RegExpExecArray | null;
  _INLINE_CITATION.lastIndex = 0;
  while ((m = _INLINE_CITATION.exec(input.body_markdown)) !== null) {
    used.add(m[0]);
  }

  const declared = new Set(input.evidence_refs);
  const undeclared: string[] = [...used].filter(
    (ref) => ref !== "[unsourced]" && !declared.has(ref),
  );

  const section = `## ${input.heading.trim()}\n\n${input.body_markdown.trim()}\n`;

  return DraftSectionOut.parse({
    section_markdown: section,
    declared_refs: [...declared],
    used_refs: [...used],
    undeclared_refs: undeclared,
    has_unsourced_claims: used.has("[unsourced]"),
  });
}

// ---------- Factory ----------------------------------------------------------

export function buildDraftSectionTool() {
  return defineTool({
    id: "draft_section",
    description:
      "Compose a report section. Validates inline citation tokens " +
      "([exp:...], [rxn:...], [proj:...], [doc:...], [kg:...], [unsourced]). " +
      "Returns formatted markdown with audit trail of declared vs used citations.",
    inputSchema: DraftSectionIn,
    outputSchema: DraftSectionOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => draftSection(input),
  });
}
