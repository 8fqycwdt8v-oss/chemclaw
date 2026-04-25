// Tests for buildFetchOriginalDocumentTool (Phase B.1).
//
// Coverage:
//   1. markdown short-path — reads parsed_markdown from DB; does NOT call mcp-doc-fetcher.
//   2. bytes path — calls mcp-doc-fetcher /fetch; returns Citation.
//   3. pdf_pages path — calls mcp-doc-fetcher /pdf_pages; citation has page set.
//   4. missing original_uri — bytes path throws a clear error.
//   5. RLS-scoped DB read — withUserContext is called with the user's Entra-ID.
//   6. citation populated correctly for bytes (source_kind + source_uri).
//   7. citation page populated for pdf_pages (first requested page).
//   8. document not found — throws "not found or not accessible".
//   9. default pages=[0] when pages not provided for pdf_pages.
//  10. mcp-doc-fetcher error propagates as UpstreamError.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool, PoolClient } from "pg";
import { buildFetchOriginalDocumentTool } from "../../src/tools/builtins/fetch_original_document.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const DOC_ID = "11111111-1111-1111-1111-111111111111";
const DOC_FETCHER_URL = "http://mcp-doc-fetcher:8006";

function makeCtx(userId = "chemist@example.com") {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: userId, scratchpad, seenFactIds };
}

// Build a mock Pool that returns a fixed set of rows.
function makePool(rows: unknown[]): Pool {
  const mockClient: Partial<PoolClient> = {
    query: vi.fn().mockResolvedValue({ rows }),
    release: vi.fn(),
  };
  return {
    connect: vi.fn().mockResolvedValue(mockClient),
  } as unknown as Pool;
}

// Mock fetch for mcp-doc-fetcher calls.
function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify(body),
  } as Response);
}

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

const ROW_WITH_MARKDOWN_ONLY = {
  id: DOC_ID,
  title: "Synthesis SOP v3",
  parsed_markdown: "# Synthesis SOP\n\nProcedure text here.",
  original_uri: null,
};

const ROW_WITH_URI = {
  id: DOC_ID,
  title: "Crystallisation Report",
  parsed_markdown: "# Report\n\nParsed content.",
  original_uri: "file:///data/docs/crystallisation_report.pdf",
};

// ---------------------------------------------------------------------------
// Helper to begin the withUserContext transaction path.
// withUserContext does: connect → BEGIN → set_config → fn → COMMIT → release
// ---------------------------------------------------------------------------

function makePoolWithTransactionMock(rows: unknown[]): Pool {
  const mockClient: Partial<PoolClient> = {
    query: vi
      .fn()
      .mockResolvedValueOnce({})                     // BEGIN
      .mockResolvedValueOnce({})                     // set_config
      .mockResolvedValueOnce({ rows })               // SELECT
      .mockResolvedValueOnce({}),                    // COMMIT
    release: vi.fn(),
  };
  return {
    connect: vi.fn().mockResolvedValue(mockClient),
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildFetchOriginalDocumentTool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── 1. markdown short-path ────────────────────────────────────────────────

  it("markdown format reads parsed_markdown from DB without calling mcp-doc-fetcher", async () => {
    const pool = makePoolWithTransactionMock([ROW_WITH_MARKDOWN_ONLY]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildFetchOriginalDocumentTool(pool, DOC_FETCHER_URL);
    const result = await tool.execute(makeCtx(), {
      document_id: DOC_ID,
      format: "markdown",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      format: "markdown",
      document_id: DOC_ID,
      title: "Synthesis SOP v3",
      markdown: expect.stringContaining("Synthesis SOP"),
    });
  });

  // ── 2. bytes path ─────────────────────────────────────────────────────────

  it("bytes format calls mcp-doc-fetcher /fetch and returns citation", async () => {
    const pool = makePoolWithTransactionMock([ROW_WITH_URI]);
    const fetchResp = {
      content_type: "application/pdf",
      base64_bytes: "JVBERi0x",
      byte_count: 6,
    };
    vi.stubGlobal("fetch", mockFetchOk(fetchResp));

    const tool = buildFetchOriginalDocumentTool(pool, DOC_FETCHER_URL);
    const result = await tool.execute(makeCtx(), {
      document_id: DOC_ID,
      format: "bytes",
    });

    expect(result).toMatchObject({
      format: "bytes",
      document_id: DOC_ID,
      content_type: "application/pdf",
      base64_bytes: "JVBERi0x",
      byte_count: 6,
    });
  });

  // ── 3. pdf_pages path ─────────────────────────────────────────────────────

  it("pdf_pages format calls mcp-doc-fetcher /pdf_pages and returns pages", async () => {
    const pool = makePoolWithTransactionMock([ROW_WITH_URI]);
    const pdfPagesResp = {
      pages: [
        { page: 2, base64_png: "abc123", width: 1200, height: 1600 },
      ],
      warning: null,
    };
    vi.stubGlobal("fetch", mockFetchOk(pdfPagesResp));

    const tool = buildFetchOriginalDocumentTool(pool, DOC_FETCHER_URL);
    const result = await tool.execute(makeCtx(), {
      document_id: DOC_ID,
      format: "pdf_pages",
      pages: [2],
    });

    expect(result).toMatchObject({
      format: "pdf_pages",
      document_id: DOC_ID,
      pages: [{ page: 2, base64_png: "abc123", width: 1200, height: 1600 }],
    });
  });

  // ── 4. missing original_uri raises a clear error for bytes ────────────────

  it("bytes format throws a clear error when original_uri is null", async () => {
    const pool = makePoolWithTransactionMock([ROW_WITH_MARKDOWN_ONLY]); // no original_uri
    const tool = buildFetchOriginalDocumentTool(pool, DOC_FETCHER_URL);

    await expect(
      tool.execute(makeCtx(), { document_id: DOC_ID, format: "bytes" }),
    ).rejects.toThrow(/no original_uri/);
  });

  // ── 5. RLS-scoped DB read ─────────────────────────────────────────────────

  it("passes the user Entra-ID through withUserContext for RLS", async () => {
    const mockClient: Partial<PoolClient> = {
      query: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockImplementationOnce((_sql: string, params: string[]) => {
          // This is the set_config call — capture the entra-id value.
          expect(params[0]).toBe("scientist@pharma.com");
          return Promise.resolve({});
        })
        .mockResolvedValueOnce({ rows: [ROW_WITH_MARKDOWN_ONLY] })
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(mockClient),
    } as unknown as Pool;

    const tool = buildFetchOriginalDocumentTool(pool, DOC_FETCHER_URL);
    await tool.execute(makeCtx("scientist@pharma.com"), {
      document_id: DOC_ID,
      format: "markdown",
    });

    expect(mockClient.query).toHaveBeenCalled();
  });

  // ── 6. citation populated correctly for bytes ─────────────────────────────

  it("bytes result has Citation with source_kind=original_doc and source_uri", async () => {
    const pool = makePoolWithTransactionMock([ROW_WITH_URI]);
    vi.stubGlobal(
      "fetch",
      mockFetchOk({
        content_type: "application/pdf",
        base64_bytes: "abc",
        byte_count: 3,
      }),
    );

    const tool = buildFetchOriginalDocumentTool(pool, DOC_FETCHER_URL);
    const result = await tool.execute(makeCtx(), {
      document_id: DOC_ID,
      format: "bytes",
    });

    expect(result).toMatchObject({
      citation: {
        source_id: DOC_ID,
        source_kind: "original_doc",
        source_uri: ROW_WITH_URI.original_uri,
      },
    });
  });

  // ── 7. citation page populated for pdf_pages ──────────────────────────────

  it("pdf_pages citation has page set to the first requested page", async () => {
    const pool = makePoolWithTransactionMock([ROW_WITH_URI]);
    vi.stubGlobal(
      "fetch",
      mockFetchOk({
        pages: [{ page: 5, base64_png: "xyz", width: 1000, height: 1400 }],
        warning: null,
      }),
    );

    const tool = buildFetchOriginalDocumentTool(pool, DOC_FETCHER_URL);
    const result = await tool.execute(makeCtx(), {
      document_id: DOC_ID,
      format: "pdf_pages",
      pages: [5, 6],
    });

    expect(result).toMatchObject({
      citation: {
        source_kind: "original_doc",
        page: 5,
      },
    });
  });

  // ── 8. document not found ─────────────────────────────────────────────────

  it("throws 'not found or not accessible' when the DB returns no rows", async () => {
    const pool = makePoolWithTransactionMock([]); // empty rows → document not found
    const tool = buildFetchOriginalDocumentTool(pool, DOC_FETCHER_URL);

    await expect(
      tool.execute(makeCtx(), { document_id: DOC_ID, format: "markdown" }),
    ).rejects.toThrow(/not found or not accessible/);
  });

  // ── 9. default pages=[0] for pdf_pages ────────────────────────────────────

  it("pdf_pages defaults to pages=[0] when pages is not supplied", async () => {
    const pool = makePoolWithTransactionMock([ROW_WITH_URI]);
    const fetchMock = mockFetchOk({
      pages: [{ page: 0, base64_png: "def", width: 800, height: 1100 }],
      warning: null,
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildFetchOriginalDocumentTool(pool, DOC_FETCHER_URL);
    await tool.execute(makeCtx(), {
      document_id: DOC_ID,
      format: "pdf_pages",
      // pages deliberately omitted
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { pages: number[] };
    expect(body.pages).toEqual([0]);
  });

  // ── 10. mcp-doc-fetcher error propagates ──────────────────────────────────

  it("propagates UpstreamError when mcp-doc-fetcher returns non-OK status", async () => {
    const pool = makePoolWithTransactionMock([ROW_WITH_URI]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 501,
        text: async () => "smb:// not yet wired",
      } as unknown as Response),
    );

    const tool = buildFetchOriginalDocumentTool(pool, DOC_FETCHER_URL);
    await expect(
      tool.execute(makeCtx(), { document_id: DOC_ID, format: "bytes" }),
    ).rejects.toThrow(/501/);
  });
});
