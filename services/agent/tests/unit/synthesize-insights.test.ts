import { describe, it, expect, vi } from "vitest";
import {
  SynthesizeInsightsInput,
  synthesizeInsights,
} from "../../src/tools/synthesize-insights.js";

const ids = Array.from({ length: 3 }, (_, i) => `33333333-3333-3333-3333-33333333333${i}`);
const facts = Array.from({ length: 3 }, (_, i) => `ffffffff-ffff-ffff-ffff-ffffffffff${i}a`);

describe("synthesize_insights", () => {
  it("drops insights whose fact_ids the agent has not seen", async () => {
    const pool = { connect: vi.fn() } as any;
    const kg = {} as any;
    const embedder = {} as any;
    const prompts = {
      getActive: vi.fn(async () => ({
        template: "SYNTH", version: 1,
      })),
    } as any;
    const llm = {
      completeJson: vi.fn(async () => ({
        insights: [
          {
            claim: "This is a fabricated claim that should be filtered out.",
            evidence_fact_ids: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
            evidence_reaction_ids: [], support_strength: "weak",
          },
          {
            claim: "This is a real claim grounded in seen facts.",
            evidence_fact_ids: [facts[0]],
            evidence_reaction_ids: [ids[0]], support_strength: "moderate",
          },
        ],
        summary: "summary",
      })),
    } as any;
    const seen = new Set([facts[0]]);
    const out = await synthesizeInsights(
      SynthesizeInsightsInput.parse({
        reaction_set: ids,
        question: "What trends appear across these reactions?",
      }),
      { pool, kg, embedder, userEntraId: "user-a", seenFactIds: seen, prompts, llm },
    );
    expect(out.insights.map((i) => i.claim)).toEqual([
      "This is a real claim grounded in seen facts.",
    ]);
  });

  it("returns empty insights when every evidence_fact_id is unseen", async () => {
    const prompts = {
      getActive: vi.fn(async () => ({ template: "SYNTH", version: 1 })),
    } as any;
    const llm = {
      completeJson: vi.fn(async () => ({
        insights: [{
          claim: "A claim with no grounded evidence at all here.",
          evidence_fact_ids: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
          evidence_reaction_ids: [],
          support_strength: "weak",
        }],
        summary: "empty",
      })),
    } as any;
    const out = await synthesizeInsights(
      SynthesizeInsightsInput.parse({
        reaction_set: ids, question: "What patterns exist across these reactions?",
      }),
      {
        pool: { connect: vi.fn() } as any, kg: {} as any, embedder: {} as any,
        userEntraId: "user-a", seenFactIds: new Set(), prompts, llm,
      },
    );
    expect(out.insights).toEqual([]);
    expect(out.summary).toBe("empty");
  });
});
