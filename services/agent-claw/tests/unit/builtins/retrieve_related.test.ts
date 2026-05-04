// Tests for buildRetrieveRelatedTool — Tranche 3 / H1.
//
// We supply mock tool instances for the search_knowledge and query_kg
// arms so the test exercises the merge / fusion logic without needing
// Postgres or mcp-kg.

import { describe, it, expect, vi } from "vitest";
import { buildRetrieveRelatedTool } from "../../../src/tools/builtins/retrieve_related.js";
import type { Tool } from "../../../src/tools/tool.js";
import { makeCtx } from "../../helpers/make-ctx.js";
import type { SearchKnowledgeInput, SearchKnowledgeOutput } from "../../../src/tools/builtins/search_knowledge.js";
import type { QueryKgInput, QueryKgOutput } from "../../../src/tools/builtins/query_kg.js";

function makeChunk(id: string): SearchKnowledgeOutput["hits"][number] {
  return {
    chunk_id: id,
    document_id: "11111111-1111-1111-1111-111111111111",
    heading_path: null,
    text: `text-${id}`,
    source_type: "report",
    document_title: null,
    score: 0.9,
    citation: { source_id: id, source_type: "document_chunk" } as never,
  };
}

function makeFact(id: string): QueryKgOutput["facts"][number] {
  return {
    fact_id: id,
    subject: { label: "Compound", id_property: "inchikey", id_value: "KEY" },
    predicate: "HAS_YIELD",
    object: {
      label: "YieldMeasurement",
      id_property: "id",
      id_value: `ym-${id}`,
    },
    edge_properties: {},
    confidence_tier: "multi_source_llm" as const,
    confidence_score: 0.8,
    t_valid_from: "2026-01-01T00:00:00Z",
    t_valid_to: null,
    recorded_at: "2026-01-01T00:00:00Z",
    provenance: { source_type: "ELN", source_id: "ELN-1" },
  };
}

function makeMockSearchKnowledge(
  chunkIds: string[],
): Tool<SearchKnowledgeInput, SearchKnowledgeOutput> {
  return {
    id: "search_knowledge",
    description: "mock",
    inputSchema: { parse: (v) => v } as never,
    outputSchema: { parse: (v) => v } as never,
    execute: vi.fn(async () => ({
      mode: "hybrid",
      hits: chunkIds.map(makeChunk),
    })),
  } as Tool<SearchKnowledgeInput, SearchKnowledgeOutput>;
}

function makeMockQueryKg(
  factIds: string[],
): Tool<QueryKgInput, QueryKgOutput> {
  return {
    id: "query_kg",
    description: "mock",
    inputSchema: { parse: (v) => v } as never,
    outputSchema: { parse: (v) => v } as never,
    execute: vi.fn(async () => ({ facts: factIds.map(makeFact) })),
  } as Tool<QueryKgInput, QueryKgOutput>;
}

const FACT_UUID_1 = "aaaaaaaa-bbbb-cccc-dddd-111111111111";
const FACT_UUID_2 = "aaaaaaaa-bbbb-cccc-dddd-222222222222";
const CHUNK_UUID_1 = "11111111-2222-3333-4444-555555555555";
const CHUNK_UUID_2 = "11111111-2222-3333-4444-666666666666";

describe("buildRetrieveRelatedTool", () => {
  it("runs both arms when an entity is supplied", async () => {
    const search = makeMockSearchKnowledge([CHUNK_UUID_1, CHUNK_UUID_2]);
    const queryKg = makeMockQueryKg([FACT_UUID_1, FACT_UUID_2]);
    const tool = buildRetrieveRelatedTool(search, queryKg);

    const out = await tool.execute(makeCtx(), {
      query: "what do we know about compound X?",
      entity: { label: "Compound", id_property: "inchikey", id_value: "KEY1" },
      top_k: 10,
    });

    expect(search.execute).toHaveBeenCalledTimes(1);
    expect(queryKg.execute).toHaveBeenCalledTimes(1);
    expect(out.arm_counts.chunks).toBe(2);
    expect(out.arm_counts.facts).toBe(2);
    expect(out.items).toHaveLength(4);
    // Each item carries kind + rrf_score.
    for (const item of out.items) {
      expect(["chunk", "fact"]).toContain(item.kind);
      expect(typeof item.rrf_score).toBe("number");
      expect(Array.isArray(item.ranks)).toBe(true);
    }
  });

  it("skips the KG arm when no entity is supplied", async () => {
    const search = makeMockSearchKnowledge([CHUNK_UUID_1]);
    const queryKg = makeMockQueryKg([FACT_UUID_1]);
    const tool = buildRetrieveRelatedTool(search, queryKg);

    const out = await tool.execute(makeCtx(), {
      query: "free-text only",
      top_k: 5,
    });

    expect(search.execute).toHaveBeenCalledTimes(1);
    expect(queryKg.execute).not.toHaveBeenCalled();
    expect(out.arm_counts.chunks).toBe(1);
    expect(out.arm_counts.facts).toBe(0);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.kind).toBe("chunk");
  });

  it("respects top_k after fusion", async () => {
    const search = makeMockSearchKnowledge([
      CHUNK_UUID_1,
      CHUNK_UUID_2,
    ]);
    const queryKg = makeMockQueryKg([FACT_UUID_1, FACT_UUID_2]);
    const tool = buildRetrieveRelatedTool(search, queryKg);

    const out = await tool.execute(makeCtx(), {
      query: "x",
      entity: { label: "Compound", id_property: "inchikey", id_value: "KEY1" },
      top_k: 2,
    });
    expect(out.items).toHaveLength(2);
  });

  it("requests 2× top_k from each arm to leave room for cross-list promotion", async () => {
    const search = makeMockSearchKnowledge([]);
    const queryKg = makeMockQueryKg([]);
    const tool = buildRetrieveRelatedTool(search, queryKg);

    await tool.execute(makeCtx(), {
      query: "x",
      entity: { label: "Compound", id_property: "inchikey", id_value: "KEY1" },
      top_k: 5,
    });

    const searchCall = (search.execute as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const searchInput = searchCall[1] as SearchKnowledgeInput;
    expect(searchInput.k).toBe(10); // 2 × top_k
  });

  it("output items carry per-arm ranks for debugging", async () => {
    const search = makeMockSearchKnowledge([CHUNK_UUID_1]);
    const queryKg = makeMockQueryKg([FACT_UUID_1]);
    const tool = buildRetrieveRelatedTool(search, queryKg);

    const out = await tool.execute(makeCtx(), {
      query: "x",
      entity: { label: "Compound", id_property: "inchikey", id_value: "KEY1" },
      top_k: 5,
    });

    // ranks[0] is the chunk-arm rank, ranks[1] is the fact-arm rank.
    // -1 means "absent from this arm".
    const chunkItem = out.items.find((i) => i.kind === "chunk")!;
    expect(chunkItem.ranks[0]).toBe(0);
    expect(chunkItem.ranks[1]).toBe(-1);

    const factItem = out.items.find((i) => i.kind === "fact")!;
    expect(factItem.ranks[0]).toBe(-1);
    expect(factItem.ranks[1]).toBe(0);
  });
});
