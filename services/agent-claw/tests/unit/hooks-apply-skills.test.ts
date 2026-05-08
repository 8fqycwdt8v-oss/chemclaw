// Tests for the apply-skills pre_turn hook.
//
// The hook has two side-effects per turn:
//   1. Prepends each active skill's prompt body to the system message.
//   2. Stores the filtered tool catalog under scratchpad["skillFilteredTools"]
//      so the route can override the tool list for this turn.
//
// Both behaviours had no direct unit coverage — only indirect signals via
// the all-hooks-fire integration test. These tests pin the contract.

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { defineTool } from "../../src/tools/tool.js";
import type { Tool } from "../../src/tools/tool.js";
import type { Message, PreTurnPayload, ToolContext } from "../../src/core/types.js";
import { registerApplySkillsHook } from "../../src/core/hooks/apply-skills.js";
import type { SkillLoader } from "../../src/core/skills.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubTool(id: string): Tool {
  return defineTool({
    id,
    description: `stub for ${id}`,
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.unknown(),
    execute: async () => ({ ok: true }),
  });
}

function makeCtx(): ToolContext {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return {
    userEntraId: "test@example.com",
    scratchpad,
    seenFactIds,
  };
}

/**
 * Stub SkillLoader exposing only the public surface the hook touches:
 * activeIds, buildSystemPrompt, filterTools. A real SkillLoader would
 * pull skills off disk; the hook contract doesn't depend on disk access.
 */
function makeFakeLoader(opts: {
  activeIds?: Set<string>;
  systemPromptPrefix?: string;
  filteredToolIds?: string[];
}): SkillLoader {
  const active = opts.activeIds ?? new Set<string>();
  const filteredIds = opts.filteredToolIds;
  return {
    activeIds: active,
    buildSystemPrompt: (base: string) => {
      if (active.size === 0) return base;
      return `${opts.systemPromptPrefix ?? ""}${base}`;
    },
    filterTools: (allTools: Tool[]) =>
      filteredIds === undefined
        ? allTools
        : allTools.filter((t) => filteredIds.includes(t.id)),
  } as unknown as SkillLoader;
}

async function dispatchPreTurn(
  lc: Lifecycle,
  payload: PreTurnPayload,
): Promise<void> {
  await lc.dispatch("pre_turn", payload);
}

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

describe("apply-skills pre_turn hook", () => {
  it("leaves the system prompt untouched when no skills are active", async () => {
    const lc = new Lifecycle();
    const tools = [stubTool("a"), stubTool("b")];
    registerApplySkillsHook(lc, makeFakeLoader({ activeIds: new Set() }), tools);

    const messages: Message[] = [
      { role: "system", content: "BASE PROMPT" },
      { role: "user", content: "hi" },
    ];
    const ctx = makeCtx();
    await dispatchPreTurn(lc, { ctx, messages });

    // Empty active set → buildSystemPrompt is documented as a no-op AND
    // the hook's `loader.activeIds.size > 0` guard means it's never called
    // anyway. Either path leaves the system message verbatim.
    expect(messages[0].content).toBe("BASE PROMPT");
  });

  it("prepends active-skill bodies to the system prompt when skills are active", async () => {
    const lc = new Lifecycle();
    const tools = [stubTool("canonicalize_smiles")];
    registerApplySkillsHook(
      lc,
      makeFakeLoader({
        activeIds: new Set(["deep-research"]),
        systemPromptPrefix: "## Active skill: deep-research\n\nDR BODY\n\n",
      }),
      tools,
    );

    const messages: Message[] = [
      { role: "system", content: "BASE PROMPT" },
      { role: "user", content: "go" },
    ];
    await dispatchPreTurn(lc, { ctx: makeCtx(), messages });

    // The first message — the system prompt — has the skill block prepended.
    expect(messages[0].content).toContain("Active skill: deep-research");
    expect(messages[0].content).toContain("DR BODY");
    expect(messages[0].content.endsWith("BASE PROMPT")).toBe(true);
    // Other messages unchanged.
    expect(messages[1].content).toBe("go");
  });

  it("stores the filtered tool catalog under scratchpad.skillFilteredTools every turn", async () => {
    const lc = new Lifecycle();
    const tools = [stubTool("query_kg"), stubTool("propose_hypothesis"), stubTool("canonicalize_smiles")];
    registerApplySkillsHook(
      lc,
      makeFakeLoader({
        activeIds: new Set(["chem-skill"]),
        filteredToolIds: ["query_kg", "canonicalize_smiles"],
      }),
      tools,
    );

    const ctx = makeCtx();
    await dispatchPreTurn(lc, {
      ctx,
      messages: [{ role: "system", content: "S" }],
    });

    const filtered = ctx.scratchpad.get("skillFilteredTools") as Tool[] | undefined;
    expect(filtered).toBeDefined();
    expect(filtered!.map((t) => t.id).sort()).toEqual(["canonicalize_smiles", "query_kg"]);
    // propose_hypothesis was filtered out by the active skill set.
    expect(filtered!.find((t) => t.id === "propose_hypothesis")).toBeUndefined();
  });

  it("stores the full tool list when no skills are active (no filtering)", async () => {
    const lc = new Lifecycle();
    const tools = [stubTool("t1"), stubTool("t2")];
    registerApplySkillsHook(lc, makeFakeLoader({ activeIds: new Set() }), tools);

    const ctx = makeCtx();
    await dispatchPreTurn(lc, {
      ctx,
      messages: [{ role: "system", content: "S" }],
    });

    const filtered = ctx.scratchpad.get("skillFilteredTools") as Tool[] | undefined;
    expect(filtered?.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("does not crash when there is no system message in the conversation", async () => {
    // Sub-agent / resume paths can dispatch pre_turn before a system message
    // has been pushed; the hook must still set skillFilteredTools.
    const lc = new Lifecycle();
    const tools = [stubTool("only-tool")];
    registerApplySkillsHook(
      lc,
      makeFakeLoader({ activeIds: new Set(["s"]), systemPromptPrefix: "X\n\n" }),
      tools,
    );

    const ctx = makeCtx();
    const messages: Message[] = [{ role: "user", content: "hi" }];
    await expect(dispatchPreTurn(lc, { ctx, messages })).resolves.toBeUndefined();

    // No mutation to the user message.
    expect(messages[0].content).toBe("hi");
    expect(messages.length).toBe(1);
    // skillFilteredTools is still set — it doesn't depend on the system msg.
    const filtered = ctx.scratchpad.get("skillFilteredTools") as Tool[] | undefined;
    expect(filtered?.map((t) => t.id)).toEqual(["only-tool"]);
  });

  it("only mutates the first system message if multiple are present", async () => {
    // `messages.find(m => m.role === 'system')` returns the first match. If a
    // route ever appended a second system message, the second must remain
    // untouched. Pin the contract so a future switch to mutating all system
    // messages is a deliberate change with a test update.
    const lc = new Lifecycle();
    registerApplySkillsHook(
      lc,
      makeFakeLoader({
        activeIds: new Set(["skill"]),
        systemPromptPrefix: "PREPENDED\n\n",
      }),
      [],
    );

    const messages: Message[] = [
      { role: "system", content: "PRIMARY" },
      { role: "user", content: "hi" },
      { role: "system", content: "SECONDARY" },
    ];
    await dispatchPreTurn(lc, { ctx: makeCtx(), messages });

    expect(messages[0].content).toContain("PREPENDED");
    expect(messages[0].content.endsWith("PRIMARY")).toBe(true);
    expect(messages[2].content).toBe("SECONDARY");
  });

  it("registers exactly one pre_turn handler", () => {
    const lc = new Lifecycle();
    expect(lc.count("pre_turn")).toBe(0);
    registerApplySkillsHook(lc, makeFakeLoader({}), []);
    expect(lc.count("pre_turn")).toBe(1);
  });
});
