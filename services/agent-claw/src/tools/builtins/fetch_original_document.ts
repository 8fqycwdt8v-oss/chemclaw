// fetch_original_document — Phase B.1 builtin tool.
//
// Retrieves a document in one of three formats:
//   "markdown"  — cheap path; reads documents.parsed_markdown from Postgres (RLS-scoped).
//   "bytes"     — fetches the raw original file via mcp-doc-fetcher /fetch.
//   "pdf_pages" — renders specific PDF pages via mcp-doc-fetcher /pdf_pages.
//
// The markdown path is the default and should be preferred for text-only questions.
// The bytes/pdf_pages paths are for figures, tables, layout, or when the user
// explicitly asks "what does the original say."

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";
import type { Citation } from "../../core/types.js";

// --------------------------------------------------------------------------
// Schemas
// --------------------------------------------------------------------------

export const FetchOriginalDocumentIn = z.object({
  document_id: z.string().uuid(),
  format: z.enum(["bytes", "markdown", "pdf_pages"]).default("markdown"),
  pages: z
    .array(z.number().int().nonnegative())
    .max(50)
    .optional(),
});
export type FetchOriginalDocumentInput = z.infer<typeof FetchOriginalDocumentIn>;

// Output is a discriminated union on the format field.
export const MarkdownOutput = z.object({
  format: z.literal("markdown"),
  document_id: z.string().uuid(),
  title: z.string().nullable(),
  markdown: z.string().nullable(),
});

export const BytesOutput = z.object({
  format: z.literal("bytes"),
  document_id: z.string().uuid(),
  content_type: z.string(),
  base64_bytes: z.string(),
  byte_count: z.number(),
  citation: z.custom<Citation>(),
});

export const PdfPageItem = z.object({
  page: z.number().int().nonnegative(),
  base64_png: z.string(),
  width: z.number(),
  height: z.number(),
});

export const PdfPagesOutput = z.object({
  format: z.literal("pdf_pages"),
  document_id: z.string().uuid(),
  pages: z.array(PdfPageItem),
  citation: z.custom<Citation>(),
});

export const FetchOriginalDocumentOut = z.discriminatedUnion("format", [
  MarkdownOutput,
  BytesOutput,
  PdfPagesOutput,
]);
export type FetchOriginalDocumentOutput = z.infer<typeof FetchOriginalDocumentOut>;

// mcp-doc-fetcher response schemas (kept internal).
const _FetchOut = z.object({
  content_type: z.string(),
  base64_bytes: z.string(),
  byte_count: z.number(),
});

const _PdfPageResult = z.object({
  page: z.number(),
  base64_png: z.string(),
  width: z.number(),
  height: z.number(),
});

const _PdfPagesOut = z.object({
  pages: z.array(_PdfPageResult),
  warning: z.string().nullable().optional(),
});

// --------------------------------------------------------------------------
// DB row type
// --------------------------------------------------------------------------

interface DocRow {
  id: string;
  title: string | null;
  parsed_markdown: string | null;
  original_uri: string | null;
}

// --------------------------------------------------------------------------
// Timeout constants
// --------------------------------------------------------------------------

const _TIMEOUT_MARKDOWN_MS = 5_000;
const TIMEOUT_BYTES_MS = 60_000;
const TIMEOUT_PDF_PAGES_MS = 60_000;

// --------------------------------------------------------------------------
// Factory
// --------------------------------------------------------------------------

/**
 * Build the fetch_original_document tool.
 *
 * @param pool           — Postgres pool (for RLS-scoped document lookups)
 * @param docFetcherUrl  — base URL of the mcp-doc-fetcher service
 */
export function buildFetchOriginalDocumentTool(pool: Pool, docFetcherUrl: string) {
  const base = docFetcherUrl.replace(/\/$/, "");

  return defineTool({
    id: "fetch_original_document",
    description:
      "Retrieve a document by ID. " +
      "format='markdown' (default) returns parsed Markdown — use for text-only questions. " +
      "format='bytes' returns the raw original file (PDF/DOCX/PPTX/…) as base64 — use for " +
      "figures, tables, or layout questions. " +
      "format='pdf_pages' renders specific pages of a PDF to base64 PNG images — " +
      "use when you need to see a figure or table on a specific page.",
    inputSchema: FetchOriginalDocumentIn,
    outputSchema: FetchOriginalDocumentOut,
    annotations: { readOnly: true },

    execute: async (ctx, input) => {
      // ── 1. Lookup document row (RLS-scoped). ──────────────────────────────
      const row = await withUserContext(pool, ctx.userEntraId, async (client) => {
        const res = await client.query<DocRow>(
          `SELECT id, title, parsed_markdown, original_uri
             FROM documents
            WHERE id = $1`,
          [input.document_id],
        );
        return res.rows[0] ?? null;
      });

      if (!row) {
        throw new Error(
          `document ${input.document_id} not found or not accessible`,
        );
      }

      // ── 2. Markdown path (cheap). ─────────────────────────────────────────
      if (input.format === "markdown") {
        return {
          format: "markdown" as const,
          document_id: row.id,
          title: row.title,
          markdown: row.parsed_markdown,
        };
      }

      // ── 3. Require original_uri for bytes / pdf_pages. ────────────────────
      if (!row.original_uri) {
        throw new Error(
          `document ${input.document_id} has no original_uri — ` +
          `original-doc access requires a URI populated at ingestion. ` +
          `Use format='markdown' for text-only retrieval.`,
        );
      }

      const citation: Citation = {
        source_id: row.id,
        source_kind: "original_doc",
        source_uri: row.original_uri,
      };

      // ── 4. Bytes path. ────────────────────────────────────────────────────
      if (input.format === "bytes") {
        const fetched = await postJson(
          `${base}/fetch`,
          { uri: row.original_uri, max_bytes: 25_000_000 },
          _FetchOut,
          TIMEOUT_BYTES_MS,
          "mcp-doc-fetcher",
        );
        return {
          format: "bytes" as const,
          document_id: row.id,
          content_type: fetched.content_type,
          base64_bytes: fetched.base64_bytes,
          byte_count: fetched.byte_count,
          citation,
        };
      }

      // ── 5. PDF pages path. ────────────────────────────────────────────────
      const pages = input.pages ?? [0];
      const fetched = await postJson(
        `${base}/pdf_pages`,
        { uri: row.original_uri, pages },
        _PdfPagesOut,
        TIMEOUT_PDF_PAGES_MS,
        "mcp-doc-fetcher",
      );

      // Attach page number to citation (use the first requested page).
      const citationWithPage: Citation = { ...citation, page: pages[0] };

      return {
        format: "pdf_pages" as const,
        document_id: row.id,
        pages: fetched.pages,
        citation: citationWithPage,
      };
    },
  });
}
