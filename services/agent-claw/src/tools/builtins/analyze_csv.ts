// analyze_csv — Phase B.3 builtin tool.
//
// Parses tabular CSV data and answers a structured query about it.
//
// Input: exactly one of `document_id` (fetched via fetch_original_document bytes)
//        or `csv_text` (raw CSV string, capped at 1 MB) plus a `query` string.
//
// Output: row_count, column_summary (name, type, min/max/mean/n_missing),
//         and answer_to_query. When the query can be answered by simple aggregation
//         the answer is computed directly. When it requires LLM judgement, the
//         answer is tagged "__llm_judgement_required__" so the agent can call
//         synthesize_insights next.

import Papa from "papaparse";
import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";
import { postJson } from "../../mcp/postJson.js";

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const MAX_CSV_BYTES = 1_024 * 1_024; // 1 MB

// --------------------------------------------------------------------------
// Schemas
// --------------------------------------------------------------------------

export const AnalyzeCsvIn = z.object({
  document_id: z.string().uuid().optional(),
  csv_text: z.string().max(MAX_CSV_BYTES).optional(),
  query: z.string().min(1).max(1_000),
});
export type AnalyzeCsvInput = z.infer<typeof AnalyzeCsvIn>;

export const ColumnSummary = z.object({
  name: z.string(),
  type: z.enum(["number", "string", "date"]),
  min: z.number().optional(),
  max: z.number().optional(),
  mean: z.number().optional(),
  n_missing: z.number(),
});
export type ColumnSummaryItem = z.infer<typeof ColumnSummary>;

export const AnalyzeCsvOut = z.object({
  row_count: z.number(),
  column_summary: z.array(ColumnSummary),
  answer_to_query: z.string(),
});
export type AnalyzeCsvOutput = z.infer<typeof AnalyzeCsvOut>;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function detectType(values: string[]): "number" | "string" | "date" {
  const nonEmpty = values.filter((v) => v.trim() !== "");
  if (nonEmpty.length === 0) return "string";

  // Date detection: ISO 8601 or common date patterns.
  const dateRe = /^\d{4}-\d{2}-\d{2}(T[\d:Z.+\-]+)?$|^\d{1,2}\/\d{1,2}\/\d{4}$/;
  if (nonEmpty.every((v) => dateRe.test(v.trim()))) return "date";

  // Number detection.
  if (nonEmpty.every((v) => !isNaN(Number(v.trim())) && v.trim() !== "")) return "number";

  return "string";
}

function buildColumnSummary(
  header: string,
  values: string[],
): ColumnSummaryItem {
  const n_missing = values.filter((v) => v.trim() === "").length;
  const type = detectType(values);

  if (type === "number") {
    const nums = values
      .filter((v) => v.trim() !== "" && !isNaN(Number(v.trim())))
      .map(Number);
    const min = nums.length > 0 ? Math.min(...nums) : undefined;
    const max = nums.length > 0 ? Math.max(...nums) : undefined;
    const mean =
      nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : undefined;
    return { name: header, type, min, max, mean, n_missing };
  }

  return { name: header, type, n_missing };
}

/**
 * Simple query answerer operating on the parsed data.
 * Returns a string answer or the sentinel when LLM judgement is needed.
 */
function answerQuery(
  query: string,
  headers: string[],
  rows: string[][],
  columnSummaries: ColumnSummaryItem[],
): string {
  const q = query.toLowerCase().trim();

  // Out-of-spec / threshold queries FIRST — these are more specific than row-count queries.
  // ("above X", "below Y", "greater than", "less than")
  const thresholdMatch = query.match(
    /(\w[\w\s]*?)\s+(above|below|greater than|less than|>|<)\s+([\d.]+)/i,
  );
  if (thresholdMatch) {
    const colFragment: string = thresholdMatch[1] ?? "";
    const op: string = thresholdMatch[2] ?? "";
    const threshStr: string = thresholdMatch[3] ?? "";
    const threshold = parseFloat(threshStr);
    if (colFragment && op && !isNaN(threshold)) {
      const fragLower = colFragment.trim().toLowerCase();
      // Match either the fragment contains the column name or the column name contains the fragment.
      const matchedCol = headers.find((h) => {
        const hLower = h.toLowerCase();
        return fragLower.includes(hLower) || hLower.includes(fragLower);
      });
      if (matchedCol) {
        const colIdx = headers.indexOf(matchedCol);
        const aboveOps = ["above", "greater than", ">"];
        const isAbove = aboveOps.some((o) => op.toLowerCase().includes(o));
        const count = rows.filter((row) => {
          const val = parseFloat(row[colIdx] ?? "");
          return !isNaN(val) && (isAbove ? val > threshold : val < threshold);
        }).length;
        return (
          `${count} rows where ${matchedCol} ${isAbove ? ">" : "<"} ${threshold}.`
        );
      }
    }
  }

  // Row count queries.
  if (/how many rows|row count|number of rows/i.test(query)) {
    return `${rows.length} rows.`;
  }

  // Column list.
  if (/what columns|list columns|column names/i.test(query)) {
    return `Columns: ${headers.join(", ")}.`;
  }

  // Missing values.
  if (/missing|null|empty/i.test(query)) {
    const withMissing = columnSummaries.filter((c) => c.n_missing > 0);
    if (withMissing.length === 0) return "No missing values detected.";
    return (
      "Columns with missing values: " +
      withMissing.map((c) => `${c.name} (${c.n_missing})`).join(", ") +
      "."
    );
  }

  // Min / max queries referencing a column name.
  for (const col of columnSummaries) {
    if (col.type !== "number") continue;
    const nameLower = col.name.toLowerCase();
    if (q.includes(nameLower)) {
      if (/min(imum)?/i.test(query) && col.min !== undefined) {
        return `Minimum of ${col.name}: ${col.min}.`;
      }
      if (/max(imum)?/i.test(query) && col.max !== undefined) {
        return `Maximum of ${col.name}: ${col.max}.`;
      }
      if (/mean|average|avg/i.test(query) && col.mean !== undefined) {
        return `Mean of ${col.name}: ${col.mean.toFixed(4)}.`;
      }
      if (/range/i.test(query) && col.min !== undefined && col.max !== undefined) {
        return `Range of ${col.name}: ${col.min} – ${col.max}.`;
      }
      if (/summar|stat/i.test(query)) {
        return (
          `${col.name}: min=${col.min}, max=${col.max}, ` +
          `mean=${col.mean?.toFixed(4)}, missing=${col.n_missing}.`
        );
      }
    }
  }

  // Fallback: tag for LLM judgement.
  return "__llm_judgement_required__";
}

// mcp-doc-fetcher bytes response (reused from fetch_original_document).
const _FetchOut = z.object({
  content_type: z.string(),
  base64_bytes: z.string(),
  byte_count: z.number(),
});

// DB row for document lookup.
interface DocRow {
  id: string;
  original_uri: string | null;
}

// --------------------------------------------------------------------------
// Factory
// --------------------------------------------------------------------------

/**
 * Build the analyze_csv tool.
 *
 * @param pool           — Postgres pool (for RLS-scoped document lookups).
 * @param docFetcherUrl  — base URL of the mcp-doc-fetcher service.
 */
export function buildAnalyzeCsvTool(pool: Pool, docFetcherUrl: string) {
  const base = docFetcherUrl.replace(/\/$/, "");

  return defineTool({
    id: "analyze_csv",
    description:
      "Parse and summarize tabular CSV data. " +
      "Supply either document_id (a UUID from the documents table — the original file is fetched) " +
      "or csv_text (raw CSV string, max 1 MB). " +
      "Returns row_count, per-column summary (type, min/max/mean, missing count), " +
      "and answer_to_query. " +
      "If answer_to_query is '__llm_judgement_required__', call synthesize_insights next.",
    inputSchema: AnalyzeCsvIn,
    outputSchema: AnalyzeCsvOut,
    annotations: { readOnly: true },

    execute: async (ctx, input) => {
      // ── Validate: exactly one data source. ─────────────────────────────────
      if (!input.document_id && !input.csv_text) {
        throw new Error("analyze_csv: provide either document_id or csv_text.");
      }
      if (input.document_id && input.csv_text) {
        throw new Error(
          "analyze_csv: provide document_id OR csv_text, not both.",
        );
      }

      let rawCsv: string;

      if (input.csv_text) {
        // ── csv_text path: size already capped by the Zod schema (.max). ─────
        if (Buffer.byteLength(input.csv_text, "utf8") > MAX_CSV_BYTES) {
          throw new Error(
            `analyze_csv: csv_text exceeds 1 MB limit (${Buffer.byteLength(input.csv_text, "utf8")} bytes).`,
          );
        }
        rawCsv = input.csv_text;
      } else {
        // ── document_id path: fetch original bytes via mcp-doc-fetcher. ──────
        const row = await withUserContext(pool, ctx.userEntraId, async (client) => {
          const res = await client.query<DocRow>(
            `SELECT id, original_uri FROM documents WHERE id = $1`,
            [input.document_id],
          );
          return res.rows[0] ?? null;
        });

        if (!row) {
          throw new Error(
            `analyze_csv: document ${input.document_id} not found or not accessible.`,
          );
        }
        if (!row.original_uri) {
          throw new Error(
            `analyze_csv: document ${input.document_id} has no original_uri. ` +
              "Use csv_text to pass the CSV content directly.",
          );
        }

        const fetched = await postJson(
          `${base}/fetch`,
          { uri: row.original_uri, max_bytes: MAX_CSV_BYTES },
          _FetchOut,
          30_000,
          "mcp-doc-fetcher",
        );

        rawCsv = Buffer.from(fetched.base64_bytes, "base64").toString("utf8");
      }

      // ── Parse CSV. ──────────────────────────────────────────────────────────
      const parsed = Papa.parse<string[]>(rawCsv, {
        skipEmptyLines: true,
        header: false,
      });

      if (parsed.errors.length > 0 && parsed.data.length === 0) {
        const firstErr = parsed.errors[0];
        throw new Error(
          `analyze_csv: CSV parse failed — ${firstErr != null ? firstErr.message : "unknown error"}.`,
        );
      }

      const allRows = parsed.data as string[][];
      if (allRows.length < 1) {
        throw new Error("analyze_csv: CSV is empty.");
      }

      const headers = (allRows[0] ?? []).map((h) => h.trim());
      const dataRows = allRows.slice(1);
      const rowCount = dataRows.length;

      // ── Build column summaries. ─────────────────────────────────────────────
      const columnSummaries: ColumnSummaryItem[] = headers.map((header, idx) => {
        const values = dataRows.map((row) => row[idx] ?? "");
        return buildColumnSummary(header, values);
      });

      // ── Answer the query. ───────────────────────────────────────────────────
      const answer = answerQuery(input.query, headers, dataRows, columnSummaries);

      return {
        row_count: rowCount,
        column_summary: columnSummaries,
        answer_to_query: answer,
      };
    },
  });
}
