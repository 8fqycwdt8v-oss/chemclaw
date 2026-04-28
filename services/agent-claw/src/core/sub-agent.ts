// Sub-agent spawner — Phase B.3.
//
// Provides three spawnable sub-agent types: chemist, analyst, reader.
// Each runs in its own harness instance with its own seenFactIds set,
// fresh budget, and a restricted tool catalog.
//
// Sub-agents INHERIT the parent's userEntraId (RLS scope unchanged) and
// SHARE the parent's Postgres pool (no separate connection).
//
// The result is a typed SubAgentResult that the parent harness receives as
// a synthetic tool result via the dispatch_sub_agent tool.

import { runHarness } from "./harness.js";
import { Budget } from "./budget.js";
import type { Lifecycle } from "./lifecycle.js";
import type { HarnessResult, Message, ToolContext } from "./types.js";
import type { Tool } from "../tools/tool.js";
import type { LlmProvider } from "../llm/provider.js";

// ---------------------------------------------------------------------------
// Sub-agent types + tool subsets
// ---------------------------------------------------------------------------

export type SubAgentType = "chemist" | "analyst" | "reader";

/** Tools available to each sub-agent type. */
export const SUB_AGENT_TOOL_SUBSETS: Record<SubAgentType, string[]> = {
  chemist: [
    "find_similar_reactions",
    "expand_reaction_context",
    "statistical_analyze",
    "canonicalize_smiles",
    "query_kg",
  ],
  analyst: [
    "analyze_csv",
    "search_knowledge",
    "query_kg",
    "check_contradictions",
  ],
  reader: [
    "search_knowledge",
    "fetch_full_document",
    "fetch_original_document",
  ],
};

// Default budget caps for sub-agents (smaller than the parent turn budget).
const SUB_AGENT_DEFAULT_MAX_STEPS = 10;
const SUB_AGENT_DEFAULT_MAX_PROMPT_TOKENS = 40_000;
const SUB_AGENT_DEFAULT_MAX_COMPLETION_TOKENS = 8_000;

// ---------------------------------------------------------------------------
// Task spec + result shapes
// ---------------------------------------------------------------------------

export interface SubAgentTaskSpec {
  /** What the sub-agent should accomplish. */
  goal: string;
  /** Named input values the sub-agent can reference in the goal. */
  inputs: Record<string, unknown>;
  /** Override step cap. */
  max_steps?: number;
  /** Override prompt token budget. */
  max_tokens?: number;
}

export interface Citation {
  source_id: string;
  source_kind: string;
  source_uri?: string;
  snippet?: string;
  page?: number;
}

export interface SubAgentResult {
  text: string;
  finishReason: string;
  /** Fact/doc/rxn IDs collected by the seenFactIds set during the sub-turn. */
  citations: string[];
  stepsUsed: number;
  usage: { promptTokens: number; completionTokens: number };
}

// ---------------------------------------------------------------------------
// Spawner
// ---------------------------------------------------------------------------

export interface SubAgentDeps {
  /** Available tools registered in the parent service. */
  allTools: Tool[];
  /** LLM provider (shared with parent). */
  llm: LlmProvider;
  /**
   * Lifecycle to run the sub-harness against. Sub-agents share the
   * parent's process-wide Lifecycle (populated once at startup by
   * loadHooks() in index.ts) so every YAML-registered hook fires for
   * sub-agent turns too — no per-spawner subset, no drift.
   */
  lifecycle: Lifecycle;
}

/**
 * Spawn a sub-agent of the given type.
 *
 * @param type       — chemist | analyst | reader
 * @param taskSpec   — goal + inputs + optional budget overrides
 * @param parentCtx  — parent ToolContext (userEntraId, scratchpad inherited read-only)
 * @param deps       — shared deps (tools, LLM provider)
 */
export async function spawnSubAgent(
  type: SubAgentType,
  taskSpec: SubAgentTaskSpec,
  parentCtx: ToolContext,
  deps: SubAgentDeps,
): Promise<SubAgentResult> {
  // ── 1. Build tool subset for this sub-agent type. ──────────────────────────
  const allowedTools = new Set(SUB_AGENT_TOOL_SUBSETS[type]);
  const tools = deps.allTools.filter((t) => allowedTools.has(t.id));

  // ── 2. Build a fresh sub-agent context (own seenFactIds, own scratchpad).
  // The Set we seed here is only the INITIAL reference: when the parent's
  // process-wide Lifecycle includes init-scratch (it does in production),
  // the pre_turn dispatch inside runHarness replaces scratchpad["seenFactIds"]
  // with a fresh Set on every turn. The local `subSeenFactIds` becomes
  // orphaned at that point, so we read citations back from the scratchpad
  // at return time (see readSeenFactIds below) — the scratchpad is the
  // canonical store after pre_turn.
  const subSeenFactIds = new Set<string>();
  const subScratchpad = new Map<string, unknown>();
  subScratchpad.set("seenFactIds", subSeenFactIds);
  subScratchpad.set("budget", {
    promptTokensUsed: 0,
    completionTokensUsed: 0,
    tokenBudget: taskSpec.max_tokens ?? SUB_AGENT_DEFAULT_MAX_PROMPT_TOKENS,
  });

  const subCtx: ToolContext = {
    // RLS scope inherited from parent — immutable.
    userEntraId: parentCtx.userEntraId,
    seenFactIds: subSeenFactIds,
    scratchpad: subScratchpad,
  };

  // ── 3. Build messages. ─────────────────────────────────────────────────────
  const inputsText = Object.entries(taskSpec.inputs)
    .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
    .join("\n");

  const systemContent =
    `You are a sub-agent of type '${type}'. ` +
    `Complete the following goal using only the tools available to you. ` +
    `Cite every fact, reaction, and document chunk you use. ` +
    `Do not fabricate IDs.`;

  const userContent = taskSpec.inputs && Object.keys(taskSpec.inputs).length > 0
    ? `${taskSpec.goal}\n\nInputs:\n${inputsText}`
    : taskSpec.goal;

  const messages: Message[] = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  // ── 4. Use the parent's process-wide Lifecycle. Drift is now impossible
  // by construction — there is one Lifecycle instance per process, populated
  // by loadHooks() at startup, and every harness invocation (routes AND
  // sub-agents) dispatches against it.
  const lifecycle = deps.lifecycle;

  // ── 5. Build budget. ───────────────────────────────────────────────────────
  const budget = new Budget({
    maxSteps: taskSpec.max_steps ?? SUB_AGENT_DEFAULT_MAX_STEPS,
    maxPromptTokens: taskSpec.max_tokens ?? SUB_AGENT_DEFAULT_MAX_PROMPT_TOKENS,
    maxCompletionTokens: SUB_AGENT_DEFAULT_MAX_COMPLETION_TOKENS,
  });

  // ── 6. Run the sub-harness. ────────────────────────────────────────────────
  let result: HarnessResult;
  try {
    result = await runHarness({
      messages,
      tools,
      llm: deps.llm,
      budget,
      lifecycle,
      ctx: subCtx,
    });
  } catch (err) {
    // Sub-agent budget exceeded or other error — return partial result.
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      text: `Sub-agent (${type}) failed: ${errMsg}`,
      finishReason: "error",
      citations: [...readSeenFactIds(subCtx, subSeenFactIds)],
      stepsUsed: budget.stepsUsed,
      usage: budget.summary(),
    };
  }

  return {
    text: result.text,
    finishReason: result.finishReason,
    citations: [...readSeenFactIds(subCtx, subSeenFactIds)],
    stepsUsed: result.stepsUsed,
    usage: result.usage,
  };
}

/**
 * Read the canonical seenFactIds Set out of the sub-agent's scratchpad.
 * After init-scratch (pre_turn) runs, the scratchpad holds a different
 * Set than the one we seeded — the seeded Set becomes orphaned. Falling
 * back to the seed covers test setups that use an empty Lifecycle (no
 * init-scratch registered).
 */
function readSeenFactIds(ctx: ToolContext, fallback: Set<string>): Set<string> {
  const fromScratch = ctx.scratchpad.get("seenFactIds");
  return fromScratch instanceof Set ? (fromScratch as Set<string>) : fallback;
}
