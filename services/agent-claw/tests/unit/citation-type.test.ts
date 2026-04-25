// Tests for the Citation type in core/types.ts.
//
// These are compile-time / structural tests:
//   - The type is importable.
//   - All source_kind values are accepted.
//   - Optional fields are truly optional.
//   - A Citation can be used in a tool-result event shape.

import { describe, it, expect } from "vitest";
import type { Citation } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Compile-time shape verification (if this file compiles, the types are correct).
// ---------------------------------------------------------------------------

const minimalCitation: Citation = {
  source_id: "chunk-abc123",
  source_kind: "document_chunk",
};

const fullCitation: Citation = {
  source_id: "fact-xyz789",
  source_kind: "kg_fact",
  source_uri: "neo4j://facts/fact-xyz789",
  snippet: "The compound has a melting point of 142°C.",
  page: 3,
};

const externalUrlCitation: Citation = {
  source_id: "https://example.com/paper",
  source_kind: "external_url",
  source_uri: "https://example.com/paper",
  snippet: "Abstract: ...",
};

const originalDocCitation: Citation = {
  source_id: "doc-phase-b",
  source_kind: "original_doc",
  source_uri: "https://storage.example.com/docs/signed-url",
  page: 1,
};

// ---------------------------------------------------------------------------
// Runtime tests (verify the values are structurally correct at runtime).
// ---------------------------------------------------------------------------

describe("Citation type — source_kind values", () => {
  it("accepts 'document_chunk' source_kind", () => {
    expect(minimalCitation.source_kind).toBe("document_chunk");
    expect(minimalCitation.source_id).toBe("chunk-abc123");
  });

  it("accepts 'kg_fact' source_kind with all optional fields", () => {
    expect(fullCitation.source_kind).toBe("kg_fact");
    expect(fullCitation.snippet).toContain("142°C");
    expect(fullCitation.page).toBe(3);
  });

  it("accepts 'reaction' source_kind", () => {
    const reactionCitation: Citation = {
      source_id: "rxn-0001",
      source_kind: "reaction",
    };
    expect(reactionCitation.source_kind).toBe("reaction");
  });

  it("accepts 'external_url' source_kind", () => {
    expect(externalUrlCitation.source_kind).toBe("external_url");
    expect(externalUrlCitation.source_uri).toContain("example.com");
  });

  it("accepts 'original_doc' source_kind (Phase B reservation)", () => {
    expect(originalDocCitation.source_kind).toBe("original_doc");
    expect(originalDocCitation.source_uri).toContain("signed-url");
  });
});

describe("Citation type — optional fields", () => {
  it("source_uri is optional", () => {
    const c: Citation = { source_id: "x", source_kind: "reaction" };
    expect(c.source_uri).toBeUndefined();
  });

  it("snippet is optional", () => {
    const c: Citation = { source_id: "x", source_kind: "kg_fact" };
    expect(c.snippet).toBeUndefined();
  });

  it("page is optional", () => {
    const c: Citation = { source_id: "x", source_kind: "document_chunk" };
    expect(c.page).toBeUndefined();
  });
});

describe("Citation type — tool-result compatibility", () => {
  it("can be embedded in a tool-result output object", () => {
    // Simulates what a search_knowledge tool might return.
    const toolOutput: { results: string[]; citations: Citation[] } = {
      results: ["chunk 1 text"],
      citations: [
        { source_id: "chunk-1", source_kind: "document_chunk", snippet: "chunk 1 text", page: 5 },
      ],
    };
    expect(toolOutput.citations).toHaveLength(1);
    expect(toolOutput.citations[0]?.source_kind).toBe("document_chunk");
  });

  it("backward-compatible: tools without citations can omit the field", () => {
    // canonicalize_smiles does not produce citations; the field is absent.
    const toolOutput: { canonical_smiles: string; citations?: Citation[] } = {
      canonical_smiles: "c1ccccc1",
    };
    expect(toolOutput.citations).toBeUndefined();
  });
});
