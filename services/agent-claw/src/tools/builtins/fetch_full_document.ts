// fetch_full_document — Phase B.2 builtin.
//
// Thin alias for fetch_original_document(format='markdown').
// Exists for backward-compatibility with the legacy 12-tool catalog.
// Phase F may remove it; for now it forwards to the new tool so legacy
// agent prompts that reference fetch_full_document continue to work.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";

// ---------- Schemas ----------------------------------------------------------

export const FetchFullDocumentIn = z.object({
  document_id: z.string().uuid(),
});
export type FetchFullDocumentInput = z.infer<typeof FetchFullDocumentIn>;

export const FetchFullDocumentOut = z.object({
  document_id: z.string().uuid(),
  sha256: z.string().nullable(),
  title: z.string().nullable(),
  source_type: z.string().nullable(),
  version: z.string().nullable(),
  effective_date: z.string().nullable(),
  parsed_markdown: z.string().nullable(),
  chunk_count: z.number().int().nonnegative(),
});
export type FetchFullDocumentOutput = z.infer<typeof FetchFullDocumentOut>;

// ---------- Factory ----------------------------------------------------------

export function buildFetchFullDocumentTool(pool: Pool) {
  return defineTool({
    id: "fetch_full_document",
    description:
      "Retrieve the full parsed markdown of a document by UUID. " +
      "Use this after search_knowledge to read the complete document rather than isolated chunks. " +
      "Alias for fetch_original_document(format='markdown') — prefer that tool for bytes/pdf_pages access.",
    inputSchema: FetchFullDocumentIn,
    outputSchema: FetchFullDocumentOut,
    annotations: { readOnly: true },

    execute: async (ctx, input) => {
      const row = await withUserContext(pool, ctx.userEntraId, async (client) => {
        const r = await client.query(
          `
          SELECT d.id::text AS document_id,
                 d.sha256,
                 d.title,
                 d.source_type,
                 d.version,
                 d.effective_date::text AS effective_date,
                 d.parsed_markdown,
                 (SELECT count(*)::int FROM document_chunks c WHERE c.document_id = d.id) AS chunk_count
            FROM documents d
           WHERE d.id = $1::uuid
           LIMIT 1
          `,
          [input.document_id],
        );
        return r.rows[0] ?? null;
      });

      if (row == null) {
        throw new Error(`document not found or not accessible: ${input.document_id}`);
      }

      const cap = 200_000;
      let markdown = (row.parsed_markdown ?? "") as string;
      if (markdown.length > cap) {
        markdown =
          markdown.slice(0, cap) +
          `\n\n…[truncated: full document ${markdown.length} chars, returned ${cap}]`;
      }

      return FetchFullDocumentOut.parse({
        document_id: row.document_id,
        sha256: row.sha256 ?? null,
        title: row.title,
        source_type: row.source_type,
        version: row.version,
        effective_date: row.effective_date,
        parsed_markdown: markdown,
        chunk_count: row.chunk_count,
      });
    },
  });
}
