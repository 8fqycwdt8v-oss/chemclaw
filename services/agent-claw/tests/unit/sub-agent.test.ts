// Tests for the sub-agent spawner.

import { describe, it, expect } from "vitest";
import { spawnSubAgent, SUB_AGENT_TOOL_SUBSETS } from "../../src/core/sub-agent.js";
import { defineTool } from "../../src/tools/tool.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { z } from "zod";
import type { ToolContext } from "../../src/core/types.js";

function makeParentCtx(userId = "parent@example.com"): ToolContext {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>();
  scratchpad.set("seenFactIds", seenFactIds);
  return { userEntraId: userId, seenFactIds, scratchpad };
}

// Build a small set of stub tools covering all three sub-agent types.
const allStubTools = [
  "find_similar_reactions",
  "expand_reaction_context",
  "statistical_analyze",
  "canonicalize_smiles",
  "query_kg",
  "analyze_csv",
  "search_knowledge",
  "check_contradictions",
  "fetch_full_document",
  "fetch_original_document",
].map((id) =>
  defineTool({
    id,
    description: `stub ${id}`,
    inputSchema: z.object({ q: z.string().optional() }),
    outputSchema: z.object({ result: z.string() }),
    execute: async () => ({ result: `${id} executed` }),
  }),
);

describe("SUB_AGENT_TOOL_SUBSETS — declarations", () => {
  it("chemist tool subset is non-empty and well-typed", () => {
    expect(SUB_AGENT_TOOL_SUBSETS.chemist.length).toBeGreaterThan(0);
    expect(SUB_AGENT_TOOL_SUBSETS.chemist).toContain("find_similar_reactions");
    expect(SUB_AGENT_TOOL_SUBSETS.chemist).toContain("canonicalize_smiles");
  });

  it("analyst tool subset is non-empty and well-typed", () => {
    expect(SUB_AGENT_TOOL_SUBSETS.analyst.length).toBeGreaterThan(0);
    expect(SUB_AGENT_TOOL_SUBSETS.analyst).toContain("analyze_csv");
    expect(SUB_AGENT_TOOL_SUBSETS.analyst).toContain("check_contradictions");
  });

  it("reader tool subset is non-empty and well-typed", () => {
    expect(SUB_AGENT_TOOL_SUBSETS.reader.length).toBeGreaterThan(0);
    expect(SUB_AGENT_TOOL_SUBSETS.reader).toContain("search_knowledge");
    expect(SUB_AGENT_TOOL_SUBSETS.reader).toContain("fetch_original_document");
  });
});

describe("spawnSubAgent — basic execution", () => {
  it("spawns a reader sub-agent and returns text result", async () => {
    const llm = new StubLlmProvider();
    llm.enqueueText("The SOP requires pH 7.0.");

    const result = await spawnSubAgent(
      "reader",
      { goal: "What is the pH requirement in the SOP?", inputs: {} },
      makeParentCtx(),
      { allTools: allStubTools, llm },
    );

    expect(result.text).toContain("pH 7.0");
    expect(result.finishReason).toBe("stop");
    expect(result.stepsUsed).toBeGreaterThan(0);
  });

  it("spawns a chemist sub-agent and returns text result", async () => {
    const llm = new StubLlmProvider();
    llm.enqueueText("The best reaction used DCM at 0°C.");

    const result = await spawnSubAgent(
      "chemist",
      { goal: "Find the best reaction conditions for amide coupling.", inputs: {} },
      makeParentCtx(),
      { allTools: allStubTools, llm },
    );

    expect(result.text).toContain("DCM");
    expect(result.finishReason).toBe("stop");
  });

  it("spawns an analyst sub-agent", async () => {
    const llm = new StubLlmProvider();
    llm.enqueueText("The mean purity is 98.5%.");

    const result = await spawnSubAgent(
      "analyst",
      { goal: "Summarize the purity data.", inputs: { csv_text: "purity\n98.5\n98.2\n" } },
      makeParentCtx(),
      { allTools: allStubTools, llm },
    );

    expect(result.text).toContain("purity");
    expect(result.finishReason).toBe("stop");
  });

  it("inherits parent userEntraId (RLS scope preserved)", async () => {
    let capturedUserId = "";
    const captureTool = defineTool({
      id: "search_knowledge",
      description: "capture",
      inputSchema: z.object({ q: z.string().optional() }),
      outputSchema: z.object({ result: z.string() }),
      execute: async (subCtx) => {
        capturedUserId = subCtx.userEntraId;
        return { result: "captured" };
      },
    });

    const llm = new StubLlmProvider();
    llm.enqueueToolCall("search_knowledge", { q: "test" });
    llm.enqueueText("done");

    await spawnSubAgent(
      "reader",
      { goal: "search for something", inputs: {} },
      makeParentCtx("rls-user@example.com"),
      { allTools: [captureTool], llm },
    );

    expect(capturedUserId).toBe("rls-user@example.com");
  });

  it("uses a fresh seenFactIds set (independent from parent)", async () => {
    const llm = new StubLlmProvider();
    llm.enqueueText("done");

    const parentCtx = makeParentCtx();
    parentCtx.seenFactIds.add("parent-fact-001");

    const result = await spawnSubAgent(
      "reader",
      { goal: "simple task", inputs: {} },
      parentCtx,
      { allTools: allStubTools, llm },
    );

    // Sub-agent's citations should NOT contain the parent's fact IDs.
    expect(result.citations).not.toContain("parent-fact-001");
  });

  it("enforces max_steps budget and returns partial result", async () => {
    const llm = new StubLlmProvider();
    // Enqueue more tool calls than the budget allows.
    for (let i = 0; i < 10; i++) {
      llm.enqueueToolCall("search_knowledge", { q: "loop" });
    }
    llm.enqueueText("done");

    const result = await spawnSubAgent(
      "reader",
      { goal: "loop", inputs: {}, max_steps: 2 },
      makeParentCtx(),
      { allTools: allStubTools, llm },
    );

    expect(result.stepsUsed).toBeLessThanOrEqual(2);
    expect(["max_steps", "stop"]).toContain(result.finishReason);
  });
});
