// Tests for buildSynthesizeInsightsTool — including soft-drop hallucination guard.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildSynthesizeInsightsTool } from "../../../src/tools/builtins/synthesize_insights.js";
import { mockPool } from "../../helpers/mock-pg.js";
import { makeCtx } from "../../helpers/make-ctx.js";
import { StubLlmProvider } from "../../../src/llm/provider.js";

const MCP_KG_URL = "http://mcp-kg:8003";

const REACTION_IDS = [
  "aaaaaaaa-0000-0000-0000-000000000001",
  "aaaaaaaa-0000-0000-0000-000000000002",
  "aaaaaaaa-0000-0000-0000-000000000003",
];

const FACT_UUID = "ffffffff-0000-0000-0000-000000000001";

const CORE_ROW = {
  reaction_id: REACTION_IDS[0],
  rxn_smiles: "CC>>CCC",
  rxno_class: "C-C coupling",
  experiment_id: "bbbbbbbb-0000-0000-0000-000000000001",
  project_internal_id: "NCE-0042",
  yield_pct: "85.2",
  outcome_status: "success",
  temp_c: "80",
  time_min: "120",
  solvent: "DCM",
};

function makePrompts() {
  return {
    getActive: vi.fn().mockResolvedValue({ template: "synthesize prompt", version: 1 }),
    invalidate: vi.fn(),
    cacheAgeMs: vi.fn().mockReturnValue(null),
  };
}

describe("buildSynthesizeInsightsTool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns filtered insights that cite seen fact_ids", async () => {
    // KG returns no facts (expand will succeed but surfaced_fact_ids is empty).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ facts: [] }),
      } as Response),
    );

    const { pool, client } = mockPool();
    // Per reaction: BEGIN, set_config, core query, COMMIT
    for (let i = 0; i < REACTION_IDS.length; i++) {
      client.queryResults.push(
        { rows: [], rowCount: 0 }, // BEGIN
        { rows: [], rowCount: 0 }, // set_config
        { rows: [{ ...CORE_ROW, reaction_id: REACTION_IDS[i] }], rowCount: 1 },
        { rows: [], rowCount: 0 }, // COMMIT
      );
    }

    const llm = new StubLlmProvider();
    // Pre-seed FACT_UUID into seenFactIds (as if a prior query_kg call populated it)
    const ctx = makeCtx("scientist@pharma.com", [FACT_UUID]);

    llm.enqueueJson({
      insights: [
        {
          claim: "Catalyst A gives higher yield than B in DCM solvent with consistent results.",
          evidence_fact_ids: [FACT_UUID],
          evidence_reaction_ids: [REACTION_IDS[0]],
          support_strength: "strong",
        },
      ],
      summary: "Strong yield advantage for catalyst A.",
    });

    const tool = buildSynthesizeInsightsTool(pool, MCP_KG_URL, makePrompts() as any, llm);
    const result = await tool.execute(ctx, {
      reaction_set: REACTION_IDS,
      question: "What conditions give the highest yield?",
    });

    expect(result.insights).toHaveLength(1);
    expect(result.summary).toBe("Strong yield advantage for catalyst A.");
  });

  it("soft-drops insights with unseen fact_ids (hallucination guard)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ facts: [] }),
      } as Response),
    );

    const { pool, client } = mockPool();
    for (let i = 0; i < REACTION_IDS.length; i++) {
      client.queryResults.push(
        { rows: [], rowCount: 0 },
        { rows: [], rowCount: 0 },
        { rows: [{ ...CORE_ROW, reaction_id: REACTION_IDS[i] }], rowCount: 1 },
        { rows: [], rowCount: 0 },
      );
    }

    const llm = new StubLlmProvider();
    const ctx = makeCtx("scientist@pharma.com"); // empty seenFactIds

    const UNSEEN_FACT = "99999999-0000-0000-0000-000000000001";
    llm.enqueueJson({
      insights: [
        {
          claim: "This insight references a fact the agent never actually retrieved.",
          evidence_fact_ids: [UNSEEN_FACT],
          evidence_reaction_ids: [REACTION_IDS[0]],
          support_strength: "weak",
        },
      ],
      summary: "Possibly hallucinated summary.",
    });

    const tool = buildSynthesizeInsightsTool(pool, MCP_KG_URL, makePrompts() as any, llm);
    const result = await tool.execute(ctx, {
      reaction_set: REACTION_IDS,
      question: "What can we learn from these reactions?",
    });

    // Insight is dropped because UNSEEN_FACT is not in seenFactIds.
    expect(result.insights).toHaveLength(0);
    expect(result.summary).toBe("Possibly hallucinated summary.");
  });

  it("inputSchema rejects reaction_set with fewer than 3 items", () => {
    const { pool } = mockPool();
    const llm = new StubLlmProvider();
    const tool = buildSynthesizeInsightsTool(pool, MCP_KG_URL, makePrompts() as any, llm);
    const r = tool.inputSchema.safeParse({
      reaction_set: REACTION_IDS.slice(0, 2),
      question: "A question that is at least twenty characters long.",
    });
    expect(r.success).toBe(false);
  });
});
