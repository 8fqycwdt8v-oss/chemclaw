// Slash-command parser + dispatcher.
//
// Parses a leading /<verb> [args] from the first user message and returns a
// structured intent. Slash-only handling (isStreamable=false) short-circuits
// before the LLM harness is invoked.
//
// Supported verbs (Phase B.3):
//   /help    — returns the verb list; no LLM call.
//   /skills [enable|disable|list] <id> — manage skill packs.
//   /feedback up|down "<reason>" — writes feedback_events row; no LLM call.
//   /check   — placeholder; "(confidence ensemble lands in Phase C)".
//   /learn   — placeholder; "(skill induction lands in Phase C)".
//   /plan    — preview a step-by-step plan; emits plan_step + plan_ready SSE events.
//   /dr      — deep-research skill (activates deep_research skill for this turn).
//   /retro   — retrosynthesis skill (activates retro skill for this turn).
//   /qc      — QC/analytical skill (activates qc skill for this turn).

// ---------------------------------------------------------------------------
// Result type returned by parseSlash.
// ---------------------------------------------------------------------------
export interface SlashParseResult {
  /** The verb without the leading slash, e.g. "help". Empty string for non-slash input. */
  verb: string;
  /** Everything after the verb (trimmed). */
  args: string;
  /** The original text with the slash-command prefix stripped (may equal args). */
  remainingText: string;
  /** True when the verb can invoke the LLM harness; false for short-circuit responses. */
  isStreamable: boolean;
}

// Verbs that produce an immediate response without calling the LLM.
const SHORT_CIRCUIT_VERBS = new Set(["help", "skills", "feedback", "check", "learn"]);

// Verbs that go through the harness (possibly with special hooks).
const STREAMABLE_VERBS = new Set(["plan", "dr", "retro", "qc"]);

// All known verbs.
const ALL_VERBS = new Set([...SHORT_CIRCUIT_VERBS, ...STREAMABLE_VERBS]);

/**
 * Parse the first user message for a leading slash command.
 * Returns a result with verb="" if the message is not a slash command.
 */
export function parseSlash(text: string): SlashParseResult {
  const trimmed = text.trimStart();

  // Not a slash command.
  if (!trimmed.startsWith("/")) {
    return { verb: "", args: trimmed, remainingText: trimmed, isStreamable: true };
  }

  // Extract verb and args.
  const withoutLeadingSlash = trimmed.slice(1);
  const spaceIdx = withoutLeadingSlash.search(/\s/);
  const verb =
    spaceIdx === -1
      ? withoutLeadingSlash.toLowerCase()
      : withoutLeadingSlash.slice(0, spaceIdx).toLowerCase();
  const rawArgs = spaceIdx === -1 ? "" : withoutLeadingSlash.slice(spaceIdx + 1).trim();

  if (!ALL_VERBS.has(verb)) {
    // Unknown verb — short-circuit with a help-like error.
    return {
      verb,
      args: rawArgs,
      remainingText: rawArgs,
      isStreamable: false,
    };
  }

  return {
    verb,
    args: rawArgs,
    remainingText: rawArgs,
    isStreamable: STREAMABLE_VERBS.has(verb),
  };
}

// ---------------------------------------------------------------------------
// Help text — one line per verb.
// ---------------------------------------------------------------------------
export const HELP_TEXT = `Available commands:
  /help                           — show this list
  /skills [list|enable|disable]   — manage skill packs
  /feedback up|down "reason"      — submit feedback on the last response
  /check                          — confidence ensemble for the last response (Phase C)
  /learn                          — trigger skill induction (Phase C)
  /plan <question>                — preview a step-by-step plan before execution
  /dr <question>                  — deep-research mode (full report)
  /retro <smiles>                 — retrosynthesis route proposal
  /qc <question>                  — analytical QC question routing`;

// ---------------------------------------------------------------------------
// Feedback args parser: up|down "reason"
// ---------------------------------------------------------------------------
export interface FeedbackArgs {
  signal: "thumbs_up" | "thumbs_down";
  reason: string;
}

const SIGNAL_MAP: Record<string, FeedbackArgs["signal"]> = {
  up: "thumbs_up",
  down: "thumbs_down",
  thumbs_up: "thumbs_up",
  thumbs_down: "thumbs_down",
};

/**
 * Parse /feedback args: `up|down "optional reason"` or `up|down reason text`.
 * Returns null if the signal token is missing or invalid.
 */
export function parseFeedbackArgs(args: string): FeedbackArgs | null {
  const trimmed = args.trim();
  if (!trimmed) return null;

  // First token is the signal.
  const firstSpaceIdx = trimmed.search(/\s/);
  const signalToken =
    firstSpaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, firstSpaceIdx).toLowerCase();
  const signal = SIGNAL_MAP[signalToken];
  if (!signal) return null;

  const rest = firstSpaceIdx === -1 ? "" : trimmed.slice(firstSpaceIdx + 1).trim();

  // Strip optional surrounding quotes from reason.
  let reason = rest;
  if (
    (reason.startsWith('"') && reason.endsWith('"')) ||
    (reason.startsWith("'") && reason.endsWith("'"))
  ) {
    reason = reason.slice(1, -1);
  }

  return { signal, reason };
}

// ---------------------------------------------------------------------------
// Dispatch responses for short-circuit verbs.
// Returns the text to emit as the assistant turn, or null if it needs
// DB work (feedback — the route handles that path) or skill-loader access
// (skills — the route handles that path).
// ---------------------------------------------------------------------------
export function shortCircuitResponse(verb: string): string | null {
  switch (verb) {
    case "help":
      return HELP_TEXT;
    case "skills":
      // The route handles /skills enable|disable|list via the SkillLoader.
      // This fallback fires only if the route doesn't handle it first.
      return "Use /skills list, /skills enable <id>, or /skills disable <id>.";
    case "check":
      // Phase C: /check is handled by the route (needs the last artifact_id).
      // This fallback fires only when the route doesn't intercept first.
      return "Use /check to run the confidence ensemble on the last response.";
    case "learn":
      // Phase C: /learn is handled by the route (needs DB + LLM).
      // This fallback fires only when the route doesn't intercept first.
      return "Use /learn <title> to induce a reusable skill from the last turn.";
    default:
      return null;
  }
}
