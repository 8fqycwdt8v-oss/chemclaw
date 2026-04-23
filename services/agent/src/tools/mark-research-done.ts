// Tool: mark_research_done
//
// TERMINAL TOOL — the agent calls this once when the investigation is
// complete. It:
//   1. Assembles the final report (title + sections + open questions +
//      contradictions) into a single markdown document.
//   2. Persists it into `research_reports` under the calling user.
//   3. Returns the report_id + a URL-safe identifier the UI can link to.
//
// After this call, the agent has no more useful work to do in this turn;
// the caller should render the returned report and end the stream.
//
// Markdown hardening note: the `markdown` column is TEXT; we do not render
// it anywhere with `unsafe_allow_html=True`. Streamlit's st.markdown
// (without the flag) escapes HTML. The inbound markdown from the agent
// therefore cannot inject script into the UI. We still store it verbatim
// so later tooling can re-render with confidence.

import { z } from "zod";
import type { Pool } from "pg";

import { withUserContext } from "../db.js";

const Section = z.object({
  heading: z.string().min(1).max(400),
  body_markdown: z.string().min(1).max(40_000),
});

const Citation = z.object({
  ref: z.string().min(3).max(300),
  detail: z.string().max(2000).optional(),
});

export const MarkResearchDoneInput = z.object({
  title: z.string().min(1).max(400),
  executive_summary: z.string().min(1).max(8_000),
  sections: z.array(Section).min(1).max(30),
  open_questions: z.array(z.string().min(1).max(2_000)).max(40).default([]),
  contradictions: z.array(z.string().min(1).max(2_000)).max(40).default([]),
  citations: z.array(Citation).max(500).default([]),
});
export type MarkResearchDoneInput = z.infer<typeof MarkResearchDoneInput>;

export const MarkResearchDoneOutput = z.object({
  report_id: z.string().uuid(),
  slug: z.string(),
  markdown_length: z.number().int().nonnegative(),
});
export type MarkResearchDoneOutput = z.infer<typeof MarkResearchDoneOutput>;

export interface MarkResearchDoneDeps {
  pool: Pool;
  userEntraId: string;
  queryText: string;
  promptVersion: number;
  agentTraceId?: string;
}

function _slugify(title: string): string {
  // A URL-safe slug bounded to 80 chars. No dependency on the title's
  // content — we hash the tail so even titles with only non-alphanumeric
  // characters produce something unique.
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "report";
}

function _buildMarkdown(input: MarkResearchDoneInput): string {
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

export async function markResearchDone(
  input: MarkResearchDoneInput,
  deps: MarkResearchDoneDeps,
): Promise<MarkResearchDoneOutput> {
  const parsed = MarkResearchDoneInput.parse(input);
  const markdown = _buildMarkdown(parsed);

  const row = await withUserContext(deps.pool, deps.userEntraId, async (client) => {
    const r = await client.query<{ id: string }>(
      `INSERT INTO research_reports
         (user_entra_id, query, markdown, citations, metadata,
          prompt_version, agent_trace_id, token_count)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
       RETURNING id::text AS id`,
      [
        deps.userEntraId,
        deps.queryText,
        markdown,
        JSON.stringify(parsed.citations),
        JSON.stringify({
          title: parsed.title,
          section_count: parsed.sections.length,
          open_question_count: parsed.open_questions.length,
          contradiction_count: parsed.contradictions.length,
        }),
        deps.promptVersion,
        deps.agentTraceId ?? null,
        markdown.length,
      ],
    );
    return r.rows[0] ?? null;
  });

  if (row == null) {
    throw new Error("mark_research_done: insert did not return a row");
  }

  return MarkResearchDoneOutput.parse({
    report_id: row.id,
    slug: _slugify(parsed.title),
    markdown_length: markdown.length,
  });
}

// Exposed for unit testing without a DB.
export const _slugifyForTests = _slugify;
export const _buildMarkdownForTests = _buildMarkdown;
