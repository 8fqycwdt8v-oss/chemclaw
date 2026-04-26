// ask_user — pause the harness and surface a clarification question to the
// user. The single biggest unlock for Claude-Code-like multi-hour autonomy:
// the agent can plow through an investigation, decide it needs input, surface
// "should I proceed with X or Y?", and the user can answer days later
// without losing the entire context.
//
// Mechanism:
//   1. The model calls ask_user({question: "..."}).
//   2. The tool sets ctx.scratchpad.awaitingQuestion to the question text
//      and throws AwaitingUserInputError.
//   3. routes/chat.ts catches the error in the streaming loop, sets
//      finishReason="awaiting_user_input", and the post-loop save persists
//      awaitingQuestion to the agent_sessions row.
//   4. The SSE stream emits an awaiting_user_input event + finish, then
//      closes cleanly.
//
// Resume:
//   The client POSTs /api/chat with the same session_id and a new user
//   message containing the answer. routes/chat.ts loads the session,
//   clears awaiting_question, threads the user message into history,
//   and the harness continues.

import { z } from "zod";
import { defineTool } from "../tool.js";

export const AskUserIn = z.object({
  question: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "Plain-text clarifying question for the user. Single message, no markdown.",
    ),
});
export type AskUserInput = z.infer<typeof AskUserIn>;

export const AskUserOut = z.object({
  awaiting: z.literal(true),
  question: z.string(),
});

/**
 * Thrown by ask_user. Caught at the harness loop so the loop can
 * persist state + emit the awaiting_user_input event before closing.
 */
export class AwaitingUserInputError extends Error {
  readonly question: string;
  constructor(question: string) {
    super(`agent paused: awaiting user input — ${question.slice(0, 200)}`);
    this.name = "AwaitingUserInputError";
    this.question = question;
  }
}

export function buildAskUserTool() {
  return defineTool({
    id: "ask_user",
    description: [
      "Pause the agent and ask the user a clarifying question.",
      "Use ONLY when you genuinely cannot proceed without input — e.g. ambiguous",
      "requirements, multiple equally-valid options, or missing context that",
      "would change your approach.",
      "Do NOT use to confirm that you should proceed with an obvious next step.",
      "After this tool fires, the SSE stream ends with finishReason=",
      "'awaiting_user_input'. The user's next message resumes the session",
      "with their answer threaded into history.",
    ].join(" "),
    inputSchema: AskUserIn,
    outputSchema: AskUserOut,

    execute: async (ctx, input) => {
      // Record the question in scratchpad so chat.ts's post-turn save
      // lifts it to the awaiting_question column.
      ctx.scratchpad.set("awaitingQuestion", input.question);
      // Throw a typed error to break out of the harness loop. routes/chat.ts
      // catches AwaitingUserInputError specifically (not a generic catch).
      throw new AwaitingUserInputError(input.question);
    },
  });
}
