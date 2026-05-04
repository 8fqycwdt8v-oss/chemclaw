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
import type {
  HarnessResult,
  Message,
  SubAgentResult,
  SubAgentTaskSpec,
  SubAgentType,
  ToolContext,
} from "./types.js";
import type { Tool } from "../tools/tool.js";
import type { LlmProvider } from "../llm/provider.js";

// Re-export the SubAgent shape types from core/types.ts so existing
// `import { SubAgentType } from "../core/sub-agent.js"` callers keep working.
// Keeping these re-exports avoids touching dispatch_sub_agent.ts and the
// sub-agent test file, while breaking the circular import with types.ts.
export type { SubAgentResult, SubAgentTaskSpec, SubAgentType };

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
// Citation — kept here for callers that import it from sub-agent.ts directly.
// (The richer Citation lives in core/types.ts; this is the loose shape the
// sub-agent harness threads through to dispatch_sub_agent's wire format.)
// ---------------------------------------------------------------------------

export interface Citation {
  source_id: string;
  source_kind: string;
  source_uri?: string;
  snippet?: string;
  page?: number;
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

  const userContent = Object.keys(taskSpec.inputs).length > 0
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

  // ── 6. subagent_start (Phase 4B). Fires against the parent's lifecycle
  // BEFORE the sub-harness runs so observability hooks see start/stop pairs.
  // ────────────────────────────────────────────────────────────────────────
  const startMs = Date.now();
  await lifecycle.dispatch("subagent_start", {
    ctx: parentCtx,
    type,
    taskSpec,
    parentUserEntraId: parentCtx.userEntraId,
  });

  // ── 7. Run the sub-harness. ────────────────────────────────────────────────
  let result: HarnessResult;
  try {
    result = await runHarness({
      messages,
      tools,
      llm: deps.llm,
      budget,
      lifecycle,
      ctx: subCtx,
      // Sub-agents inherit the same DB-backed permission policies as the
      // parent. A sub-agent dispatched by an enforced parent must not
      // silently get an unenforced harness.
      permissions: { permissionMode: "enforce" },
    });
  } catch (err) {
    // Sub-agent budget exceeded or other error — return partial result.
    const errMsg = err instanceof Error ? err.message : String(err);
    const failed: SubAgentResult = {
      text: `Sub-agent (${type}) failed: ${errMsg}`,
      finishReason: "error",
      citations: [...readSeenFactIds(subCtx, subSeenFactIds)],
      stepsUsed: budget.stepsUsed,
      usage: budget.summary(),
    };
    // Phase 4B: still fire subagent_stop on failure paths so hook authors
    // can record errored sub-agent invocations alongside successful ones.
    await lifecycle.dispatch("subagent_stop", {
      ctx: parentCtx,
      type,
      result: failed,
      durationMs: Date.now() - startMs,
    });
    return failed;
  }

  const finalResult: SubAgentResult = {
    text: result.text,
    finishReason: result.finishReason,
    citations: [...readSeenFactIds(subCtx, subSeenFactIds)],
    stepsUsed: result.stepsUsed,
    usage: result.usage,
  };

  // ── 8. subagent_stop (Phase 4B). Fires after the sub-harness returns.
  await lifecycle.dispatch("subagent_stop", {
    ctx: parentCtx,
    type,
    result: finalResult,
    durationMs: Date.now() - startMs,
  });

  return finalResult;
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
