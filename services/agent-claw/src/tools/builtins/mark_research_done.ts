// mark_research_done — Phase B.2 builtin.
//
// TERMINAL TOOL. Called once when deep research is complete.
// Assembles the final report markdown and persists it to research_reports
// under the calling user's RLS context.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";

// ---------- Schemas ----------------------------------------------------------

const Section = z.object({
  heading: z.string().min(1).max(400),
  body_markdown: z.string().min(1).max(40_000),
});

const CitationEntry = z.object({
  ref: z.string().min(3).max(300),
  detail: z.string().max(2000).optional(),
});

export const MarkResearchDoneIn = z.object({
  title: z.string().min(1).max(400),
  executive_summary: z.string().min(1).max(8_000),
  sections: z.array(Section).min(1).max(30),
  open_questions: z.array(z.string().min(1).max(2_000)).max(40).default([]),
  contradictions: z.array(z.string().min(1).max(2_000)).max(40).default([]),
  citations: z.array(CitationEntry).max(500).default([]),
});
export type MarkResearchDoneInput = z.infer<typeof MarkResearchDoneIn>;

export const MarkResearchDoneOut = z.object({
  report_id: z.string().uuid(),
  slug: z.string(),
  markdown_length: z.number().int().nonnegative(),
});
export type MarkResearchDoneOutput = z.infer<typeof MarkResearchDoneOut>;

// ---------- Helpers (exported for tests) -------------------------------------

export function _slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "report";
}

export function _buildMarkdown(input: MarkResearchDoneInput): string {
  const parts: string[] = [];
  parts.push(`# ${input.title}`);
  parts.push("");
  parts.push("## Executive summary");
  parts.push("");
  parts.push(input.executive_summary);
  for (const s of input.sections) {
    parts.push("");
    parts.push(`## ${s.heading}`);
    parts.push("");
    parts.push(s.body_markdown);
  }
  if (input.contradictions.length > 0) {
    parts.push("");
    parts.push("## Contradictions");
    parts.push("");
    for (const c of input.contradictions) {
      parts.push(`- ${c}`);
    }
  }
  if (input.open_questions.length > 0) {
    parts.push("");
    parts.push("## Open questions");
    parts.push("");
    for (const q of input.open_questions) {
      parts.push(`- ${q}`);
    }
  }
  if (input.citations.length > 0) {
    parts.push("");
    parts.push("## Citations");
    parts.push("");
    for (const c of input.citations) {
      parts.push(`- ${c.ref}${c.detail ? ` — ${c.detail}` : ""}`);
    }
  }
  return parts.join("\n");
}

// ---------- Factory ----------------------------------------------------------

export interface MarkResearchDoneToolDeps {
  pool: Pool;
  /** Query text (the original user question) — stored in the report row. */
  queryText: string;
  promptVersion: number;
  agentTraceId?: string;
}

export function buildMarkResearchDoneTool(deps: MarkResearchDoneToolDeps) {
  return defineTool({
    id: "mark_research_done",
    description:
      "TERMINAL. Call once when the deep research investigation is complete. " +
      "Assembles and persists the final report to research_reports. " +
      "Returns report_id and slug for the UI to link to.",
    inputSchema: MarkResearchDoneIn,
    outputSchema: MarkResearchDoneOut,

    execute: async (ctx, input) => {
      // Normalise optional arrays with defaults (Zod parses defaults but TS
      // infers the optional form from the schema declaration).
      const normalised = MarkResearchDoneIn.parse(input);
      const markdown = _buildMarkdown(normalised);

      const row = await withUserContext(deps.pool, ctx.userEntraId, async (client) => {
        const r = await client.query<{ id: string }>(
          `INSERT INTO research_reports
             (user_entra_id, query, markdown, citations, metadata,
              prompt_version, agent_trace_id, token_count)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
           RETURNING id::text AS id`,
          [
            ctx.userEntraId,
            deps.queryText,
            markdown,
            JSON.stringify(normalised.citations),
            JSON.stringify({
              title: normalised.title,
              section_count: normalised.sections.length,
              open_question_count: normalised.open_questions.length,
              contradiction_count: normalised.contradictions.length,
            }),
            deps.promptVersion,
            deps.agentTraceId ?? null,
            markdown.length,
          ],
        );
        return r.rows[0] ?? null;
      });

      if (row == null) {
        throw new Error("mark_research_done: INSERT did not return a row");
      }

      return MarkResearchDoneOut.parse({
        report_id: row.id,
        slug: _slugify(normalised.title),
        markdown_length: markdown.length,
      });
    },
  });
}
