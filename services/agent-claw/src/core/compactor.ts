// Working-memory compactor — Phase C.1
//
// Invoked at the pre_compact lifecycle hook when the projected token count
// exceeds 60% of AGENT_TOKEN_BUDGET (from config).
//
// Strategy:
//   1. Leave the system prompt (index 0) + the most recent N=3 turns intact.
//   2. Summarize older turns into a single synopsis turn:
//      { role: "system", content: "Earlier in this conversation: ..." }
//   3. The summarizer call uses LlmProvider.completeJson with a tight 200-word prompt.
//
// The compactor is PURE — it does not mutate the input array. It returns a
// new array that the harness replaces the message window with.

import type { LlmProvider } from "../llm/provider.js";
import type { Message } from "./types.js";
import { getLogger } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Synopsis shape returned by the LLM (structured JSON call).
// ---------------------------------------------------------------------------

export interface SynopsisResult {
  /** Max 200-word synopsis preserving entity IDs, fact_ids, and decisions. */
  synopsis: string;
}

// ---------------------------------------------------------------------------
// Compactor options.
// ---------------------------------------------------------------------------

export interface CompactorOptions {
  /**
   * Token budget for the whole context window (from AGENT_TOKEN_BUDGET).
   * The compactor fires when projected usage exceeds `triggerFraction` of this.
   */
  tokenBudget: number;
  /**
   * Fraction of tokenBudget above which compaction is triggered. Default 0.60.
   */
  triggerFraction?: number;
  /**
   * Number of most-recent turns to leave intact (not summarized). Default 3.
   * A "turn" is one user+assistant message pair (or individual messages).
   */
  recentKeep?: number;
  /** LLM provider for the synopsis call (Haiku-class). */
  llm: LlmProvider;
  /**
   * Per-call AbortSignal forwarded to the summarizer's `completeJson`
   * call. When the caller (the compact-window hook) is woken by a per-
   * dispatch hook controller, this is what cancels the LLM call so the
   * 60s hook timeout actually stops in-flight work instead of letting the
   * fetch hang to its own timeout. See ADR-007 §6 (hook timeout).
   */
  signal?: AbortSignal;
  /**
   * Optional user-supplied steering for the summarizer. Forwarded from the
   * /compact slash command's argument string, appended to the system prompt
   * so the user can request e.g. "focus on the synthesis decisions only".
   * When absent, the default summarizer prompt is used unchanged.
   */
  summaryInstructions?: string;
}

const DEFAULT_TRIGGER_FRACTION = 0.60;
const DEFAULT_RECENT_KEEP = 3;

// Conservative token estimator: 4 characters ≈ 1 token.
export function estimateTokens(messages: Message[]): number {
  return Math.ceil(
    messages.reduce((sum, m) => sum + m.content.length, 0) / 4,
  );
}

// ---------------------------------------------------------------------------
// shouldCompact — exported so the hook can call it cheaply without building
// the full compactor.
// ---------------------------------------------------------------------------

export function shouldCompact(
  messages: Message[],
  tokenBudget: number,
  triggerFraction = DEFAULT_TRIGGER_FRACTION,
): boolean {
  const estimated = estimateTokens(messages);
  return estimated > tokenBudget * triggerFraction;
}

// ---------------------------------------------------------------------------
// compact — returns a rewritten message array.
// ---------------------------------------------------------------------------

export async function compact(
  messages: Message[],
  opts: CompactorOptions,
): Promise<Message[]> {
  const recentKeep = opts.recentKeep ?? DEFAULT_RECENT_KEEP;

  if (messages.length === 0) return messages;

  // The system prompt (if any) is always at index 0.
  const first = messages[0];
  const hasSystem = first?.role === "system";
  const systemMessages = hasSystem ? [first] : [];
  const nonSystem = hasSystem ? messages.slice(1) : [...messages];

  // If there are not enough messages to compact (all fit within recentKeep),
  // return the original unchanged.
  if (nonSystem.length <= recentKeep) {
    return messages;
  }

  const olderMessages = nonSystem.slice(0, nonSystem.length - recentKeep);
  const recentMessages = nonSystem.slice(nonSystem.length - recentKeep);

  // Build a single string of the older conversation for the summarizer.
  const transcript = olderMessages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");

  const baseSystemPrompt = [
    "You are a concise scientific assistant. Summarize the following conversation ",
    "transcript in at most 200 words. Preserve all entity identifiers (compound codes, ",
    "fact_ids, reaction IDs, hypothesis IDs, UUIDs), decisions made, and conclusions ",
    "reached. Omit conversational filler. Return JSON: {\"synopsis\": \"<text>\"}.",
  ].join("");

  const systemPrompt = opts.summaryInstructions
    ? `${baseSystemPrompt}\n\nAdditional steering from the user:\n${opts.summaryInstructions}`
    : baseSystemPrompt;

  let synopsis: string;
  try {
    const result = (await opts.llm.completeJson({
      system: systemPrompt,
      user: `Conversation transcript to summarize:\n\n${transcript}`,
      signal: opts.signal,
    })) as Partial<SynopsisResult>;

    synopsis =
      typeof result.synopsis === "string" && result.synopsis.trim().length > 0
        ? result.synopsis.trim()
        : transcript.slice(0, 800); // safe fallback: truncate raw
  } catch (err) {
    // On LLM failure: truncate the raw transcript to a safe length.
    // Logging the cause lets operators tell "compactor degraded due to
    // a Haiku 5xx" from "compactor degraded because the prompt got
    // pruned wrong" — both surface as the same fallback today, and
    // both would otherwise be silent.
    getLogger("agent-claw.compactor").warn(
      {
        event: "compactor_llm_failed",
        err_name: (err as Error).name,
        err_msg: (err as Error).message,
        fallback_chars: 800,
      },
      "compactor LLM call failed; falling back to raw truncate",
    );
    synopsis = transcript.slice(0, 800);
  }

  const synopsisMessage: Message = {
    role: "system",
    content: `Earlier in this conversation:\n\n${synopsis}`,
  };

  return [...systemMessages, synopsisMessage, ...recentMessages];
}
