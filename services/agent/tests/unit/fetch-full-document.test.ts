// Unit tests for fetch_full_document input/output schemas.
// Actual DB query is covered by integration tests.

import { describe, expect, it } from "vitest";
import {
  FetchFullDocumentInput,
  FetchFullDocumentOutput,
} from "../../src/tools/fetch-full-document.js";

describe("FetchFullDocumentInput", () => {
  it("accepts a valid UUID", () => {
    const v = FetchFullDocumentInput.parse({
      document_id: "11111111-1111-1111-1111-111111111111",
    });
    expect(v.document_id).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("rejects non-UUID strings", () => {
    expect(() =>
      FetchFullDocumentInput.parse({ document_id: "not-a-uuid" }),
    ).toThrow();
  });
});

describe("FetchFullDocumentOutput", () => {
  it("accepts a minimal output", () => {
    const out = FetchFullDocumentOutput.parse({
      document_id: "11111111-1111-1111-1111-111111111111",
      sha256: "abc",
      title: null,
      source_type: "SOP",
      version: null,
      effective_date: null,
      parsed_markdown: "# hi",
      chunk_count: 0,
    });
    expect(out.source_type).toBe("SOP");
  });

  it("rejects negative chunk_count", () => {
    expect(() =>
      FetchFullDocumentOutput.parse({
        document_id: "11111111-1111-1111-1111-111111111111",
        sha256: "x",
        title: null,
        source_type: "other",
        version: null,
        effective_date: null,
        parsed_markdown: "",
        chunk_count: -1,
      }),
    ).toThrow();
  });
});
