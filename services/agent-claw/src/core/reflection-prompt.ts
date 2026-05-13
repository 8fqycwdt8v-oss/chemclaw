// Reflection prompt for max_steps continuations.
//
// Replaces the boilerplate "Continue from the last step." that runChainedHarness
// fed back when a per-turn step cap tripped. The boilerplate gave the model no
// signal that it was looping or stuck — it just rewound and tried again.
//
// The reflection prompt surfaces:
//   - any loop_warnings the loop-detector hook accumulated (same tool, same
//     args, ≥ STUCK_THRESHOLD repeats)
//   - the open todos still pending — so the model can prioritise
//   - explicit guidance: reflect, then either revise the plan via manage_plan,
//     escalate via ask_user, or pick the next concrete step
//
// Kept in its own module so unit tests can exercise the prompt-building logic
// without spinning up a full harness, and so the chained-harness file stays
// focused on the loop body.

import type { ToolContext } from "./types.js";
import type { Todo } from "./session-store.js";
import type { LoopWarning } from "./hooks/loop-detector.js";
import { LOOP_WARNINGS_KEY } from "./hooks/loop-detector.js";

/**
 * Hard byte cap for the assembled reflection prompt. Keeps the prompt under
 * a single chat-completion message budget even when a session has many open
 * todos with long content. Trips truncation with a marker rather than
 * silently dropping the next-action choices.
 */
export const MAX_REFLECTION_PROMPT_BYTES = 8192;

/**
 * Per-item cap on user-supplied content rendered into the prompt
 * (todo.content; loop-warning argsHash is already a fingerprint). Bounds the
 * worst-case prompt size before the overall cap kicks in so the truncation
 * marker is rare. Characters, not bytes — JS substring is char-based; the
 * overall byte cap downstream handles the multibyte edge.
 */
const MAX_TODO_CONTENT_CHARS = 500;

function truncateChars(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

export interface ReflectionPromptInput {
  /** ctx whose scratchpad carries loop_warnings (set by loop-detector). */
  ctx: ToolContext;
  /** Open todos at the start of the new chained iteration. */
  openTodos: Todo[];
  /**
   * The harness's finishReason for the previous turn. Only "max_steps" and
   * "budget_exceeded" produce a reflection prompt; other reasons skip the
   * chained continuation entirely.
   */
  previousFinishReason: string;
}

/**
 * Build the user message that drives the next chained iteration.
 *
 * Returns null when no reflection is warranted (e.g. clean stop, awaiting
 * user input). The caller should not chain in those cases.
 */
export function buildReflectionPrompt(
  input: ReflectionPromptInput,
): string | null {
  if (
    input.previousFinishReason !== "max_steps" &&
    input.previousFinishReason !== "budget_exceeded" &&
    input.previousFinishReason !== "wall_clock_expired"
  ) {
    return null;
  }

  const lines: string[] = [];
  lines.push(
    `The previous turn ended early (reason: ${input.previousFinishReason}). ` +
      `Before continuing, REFLECT on progress and adapt:`,
  );
  lines.push("");

  const warnings =
    (input.ctx.scratchpad.get(LOOP_WARNINGS_KEY) as LoopWarning[] | undefined) ??
    [];
  if (warnings.length > 0) {
    lines.push("LOOP WARNINGS — you have called these tools repeatedly with the same arguments:");
    // Sort by occurrences desc so the worst offenders appear first.
    const sorted = [...warnings].sort((a, b) => b.occurrences - a.occurrences);
    // Cap at 5 entries so the prompt doesn't bloat on long sessions.
    for (const w of sorted.slice(0, 5)) {
      lines.push(
        `  - ${w.toolId} (×${w.occurrences}, args hash ${w.argsHash}). ` +
          `Stop retrying as-is. Try different arguments, a different tool, ` +
          `or call ask_user.`,
      );
    }
    lines.push("");
  }

  const open = input.openTodos.filter(
    (t) => t.status === "pending" || t.status === "in_progress",
  );
  if (open.length > 0) {
    lines.push("OPEN TODOS:");
    // Cap at 10 so the prompt stays bounded; the model has the full list
    // available via manage_todos action="list" if it needs more.
    for (const t of open.slice(0, 10)) {
      lines.push(
        `  - [${t.status}] (${t.ordering}) ${truncateChars(t.content, MAX_TODO_CONTENT_CHARS)}`,
      );
    }
    if (open.length > 10) {
      lines.push(`  ... and ${open.length - 10} more (call manage_todos action="list" to see all).`);
    }
    lines.push("");
  }

  lines.push("Choose ONE of these next actions and proceed:");
  lines.push("  1. If you're making progress: pick the next concrete step and execute it.");
  lines.push(
    "  2. If a step has failed repeatedly (see LOOP WARNINGS): change strategy. " +
      "Try a different tool, a different decomposition, or simpler inputs.",
  );
  lines.push(
    "  3. If the plan itself is wrong: call manage_plan to amend it " +
      "(insert / remove / replace steps).",
  );
  lines.push(
    "  4. If you genuinely need clarification or a human decision: call ask_user.",
  );
  lines.push("");
  lines.push("Stop when the work is complete or you've called ask_user.");

  const assembled = lines.join("\n");
  // Overall byte-cap belt: per-item char caps make this rare in practice,
  // but a session with 10 todos at full 500-char content + multibyte UTF-8
  // glyphs can still push the prompt above the budget. Truncate on a UTF-8
  // boundary via Buffer and append a marker so the model sees that some
  // tail was cut.
  if (Buffer.byteLength(assembled, "utf8") <= MAX_REFLECTION_PROMPT_BYTES) {
    return assembled;
  }
  const marker = "\n…[reflection prompt truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const buf = Buffer.from(assembled, "utf8").subarray(
    0,
    MAX_REFLECTION_PROMPT_BYTES - markerBytes,
  );
  return buf.toString("utf8") + marker;
}
