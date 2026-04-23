// Tool: fetch_full_document
//
// Given a document_id (UUID, returned by search_knowledge), fetch the full
// parsed_markdown so the agent can read the complete record rather than
// isolated chunks — this is the "chunks are a finding strategy, not a
// reading strategy" principle from Deliverable 4 of the plan.

import { z } from "zod";
import type { Pool } from "pg";

import { withUserContext } from "../db.js";

export const FetchFullDocumentInput = z.object({
  document_id: z.string().uuid(),
});
export type FetchFullDocumentInput = z.infer<typeof FetchFullDocumentInput>;

export const FetchFullDocumentOutput = z.object({
  document_id: z.string().uuid(),
  sha256: z.string(),
  title: z.string().nullable(),
  source_type: z.string(),
  version: z.string().nullable(),
  effective_date: z.string().nullable(),
  parsed_markdown: z.string(),
  chunk_count: z.number().int().nonnegative(),
});
export type FetchFullDocumentOutput = z.infer<typeof FetchFullDocumentOutput>;

export interface FetchFullDocumentDeps {
  pool: Pool;
  userEntraId: string;
  /** Absolute cap on the returned markdown length (characters). */
  maxChars?: number;
}

export async function fetchFullDocument(
  input: FetchFullDocumentInput,
  deps: FetchFullDocumentDeps,
): Promise<FetchFullDocumentOutput> {
  const parsed = FetchFullDocumentInput.parse(input);
  const cap = deps.maxChars ?? 200_000;

  const row = await withUserContext(deps.pool, deps.userEntraId, async (client) => {
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
      [parsed.document_id],
    );
    return r.rows[0] ?? null;
  });

  if (row == null) {
    throw new Error(`document not found: ${parsed.document_id}`);
  }

  let markdown = (row.parsed_markdown ?? "") as string;
  if (markdown.length > cap) {
    markdown =
      markdown.slice(0, cap) +
      `\n\n…[truncated: full document ${markdown.length} chars, returned ${cap}]`;
  }

  return FetchFullDocumentOutput.parse({
    document_id: row.document_id,
    sha256: row.sha256,
    title: row.title,
    source_type: row.source_type,
    version: row.version,
    effective_date: row.effective_date,
    parsed_markdown: markdown,
    chunk_count: row.chunk_count,
  });
}
