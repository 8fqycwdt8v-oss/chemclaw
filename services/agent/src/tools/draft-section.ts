// Tool: draft_section
//
// A composition helper. Takes structured inputs (heading, evidence refs,
// body markdown) and returns a validated section string with enforced
// citation format. The tool does NOT call an LLM — it's server-side
// composition with validation. The LLM provides the narrative text
// through `body_markdown`; we sanity-check its citation references.
//
// Why a tool (rather than letting the model return free-form): explicit
// typing makes the citation contract testable and the report-assembly
// workflow inspectable in Langfuse traces. The model can still write any
// prose it wants; this tool just normalises presentation + catches
// unsourced claims flagged as `[unsourced]`.

import { z } from "zod";

const CitationRef = z
  .string()
  .min(3)
  .max(300)
  .regex(
    /^\[(exp|rxn|proj|doc|kg|unsourced)(:[^\]]{1,256})?\]$/,
    "citation must be one of [exp:...] [rxn:...] [proj:...] [doc:...] [kg:...] or [unsourced]",
  );

export const DraftSectionInput = z.object({
  heading: z.string().min(1).max(400),
  /**
   * Inline citation tokens the agent plans to reference. Used both to
   * validate that citations appearing in `body_markdown` are on the
   * declared list (catches typos) and to surface citation coverage in
   * Langfuse traces.
   */
  evidence_refs: z.array(CitationRef).max(200),
  body_markdown: z.string().min(1).max(40_000),
});
export type DraftSectionInput = z.infer<typeof DraftSectionInput>;

export const DraftSectionOutput = z.object({
  section_markdown: z.string(),
  declared_refs: z.array(z.string()),
  used_refs: z.array(z.string()),
  undeclared_refs: z.array(z.string()),
  has_unsourced_claims: z.boolean(),
});
export type DraftSectionOutput = z.infer<typeof DraftSectionOutput>;

// Inline citation pattern: bracketed token of shape [kind] or [kind:value].
// Bounded length per token so there's no ReDoS surface.
const _INLINE_CITATION = /\[(?:exp|rxn|proj|doc|kg|unsourced)(?::[^\]]{1,256})?\]/g;

export function draftSection(input: DraftSectionInput): DraftSectionOutput {
  const parsed = DraftSectionInput.parse(input);

  const used = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = _INLINE_CITATION.exec(parsed.body_markdown)) !== null) {
    used.add(m[0]);
  }

  const declared = new Set(parsed.evidence_refs);
  const undeclared: string[] = [...used].filter(
    (ref) => ref !== "[unsourced]" && !declared.has(ref),
  );

  const section = `## ${parsed.heading.trim()}\n\n${parsed.body_markdown.trim()}\n`;

  return DraftSectionOutput.parse({
    section_markdown: section,
    declared_refs: [...declared],
    used_refs: [...used],
    undeclared_refs: undeclared,
    has_unsourced_claims: used.has("[unsourced]"),
  });
}
