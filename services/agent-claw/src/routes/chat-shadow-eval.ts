// Shadow-evaluation fire-and-forget gate for the chat route.
//
// Extracted from routes/chat.ts as part of the PR-6 god-file split
// (priority 2 in the code-reviewer agent's recommended ordering — zero
// ordering risk because the call has no wire dependencies and is
// fire-and-forget).
//
// The shadow evaluator (Phase E GEPA pipeline) runs the same prompt
// through any active shadow versions in the prompt registry and
// records scores in shadow_run_scores. We only fire it when the turn
// reached a clean "stop" finishReason; awaiting-input / cancelled /
// budget-exceeded turns are not representative samples for prompt
// scoring.

import type { FastifyBaseLogger } from "fastify";
import type { ShadowEvaluator } from "../prompts/shadow-evaluator.js";
import type { Message } from "../core/types.js";

export interface MaybeFireShadowEvalInput {
  shadowEvaluator: ShadowEvaluator | undefined;
  finishReason: string;
  messages: Message[];
  traceId: string | null;
  userEntraId: string;
  log: FastifyBaseLogger;
}

/**
 * Fire-and-forget shadow evaluation for the just-completed turn. No-op
 * unless `shadowEvaluator` is wired AND finishReason === "stop". The
 * shadow call itself runs detached (\`void\`) so a slow shadow LLM call
 * doesn't delay the SSE response close.
 */
export function maybeFireShadowEval(input: MaybeFireShadowEvalInput): void {
  if (!input.shadowEvaluator || input.finishReason !== "stop") {
    return;
  }
  void input.shadowEvaluator
    .evaluateAsync({
      promptName: "agent.system",
      messages: input.messages,
      traceId: input.traceId,
      userEntraId: input.userEntraId,
    })
    .catch((shadowErr: unknown) => {
      input.log.debug({ err: shadowErr }, "shadow eval failed (non-fatal)");
    });
}
