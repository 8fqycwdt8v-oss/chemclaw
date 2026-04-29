// End-of-turn finalization for the streaming /api/chat path.
//
// Owns the finally-block dance:
//   1. Persist in-flight stream redactions to scratchpad.
//   2. persistTurnState (saveSession + ack-the-redact-log + truncate question).
//   3. If the model called ask_user, emit awaiting_user_input BEFORE finish.
//   4. Dispatch session_end on a clean stop.
//   5. Emit terminal `finish` event.
//   6. Close the OTel root span with usage.
//   7. Release the Paperclip reservation (best-effort).
//   8. Fire shadow eval on a clean stop.
//   9. Run cleanupSkillForTurn and close the socket.
//
// Reuses persistTurnState from core/session-state.ts — no re-implementation.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Span } from "@opentelemetry/api";
import type { Budget } from "../../core/budget.js";
import type { ToolContext, Message } from "../../core/types.js";
import type { RedactReplacement } from "../../core/hooks/redact-secrets.js";
import { persistTurnState } from "../../core/session-state.js";
import { lifecycle } from "../../core/runtime.js";
import { writeEvent } from "../../streaming/sse.js";
import { recordLlmUsage, recordSpanError } from "../../observability/spans.js";
import {
  USD_PER_TOKEN_ESTIMATE,
  type ReservationHandle,
} from "../../core/paperclip-client.js";
import type { ShadowEvaluator } from "../../prompts/shadow-evaluator.js";

export interface FinalizeStreamingTurnArgs {
  pool: Pool;
  user: string;
  sessionId: string | null;
  ctx: ToolContext;
  messages: Message[];
  budget: Budget | undefined;
  finishReason: string;
  closed: boolean;
  streamRedactions: RedactReplacement[];
  sessionEtag: string | undefined;
  sessionStepsUsed: number;
  paperclipHandle: ReservationHandle | null;
  rootSpan: Span;
  shadowEvaluator?: ShadowEvaluator;
  agentTraceId: string | undefined;
  cleanupSkillForTurn: (() => void) | undefined;
  agentModel: string;
}

/**
 * Persist the per-delta redaction log to scratchpad. This is appended
 * AFTER the post_turn hook's redact-secrets entry; the two are independent
 * (redact-secrets reads/writes its own entry from finalText, this one
 * captures the per-delta scrubs the SSE sink performed mid-stream).
 */
function persistStreamRedactions(
  req: FastifyRequest,
  ctx: ToolContext,
  replacements: RedactReplacement[],
): void {
  if (replacements.length === 0) return;
  try {
    const existing =
      (ctx.scratchpad.get("redact_log") as Array<{
        scope: string;
        replacements: RedactReplacement[];
        timestamp: string;
      }>) ?? [];
    ctx.scratchpad.set("redact_log", [
      ...existing,
      {
        scope: "stream_delta",
        replacements,
        timestamp: new Date().toISOString(),
      },
    ]);
  } catch (logErr) {
    req.log.warn({ err: logErr }, "stream redaction-log persist failed");
  }
}

/**
 * Best-effort Paperclip release. Mirrors the same shape as the chained
 * harness loop and the non-streaming chat path so a future cost-model
 * change touches one helper rather than four call sites.
 */
async function releasePaperclipBestEffort(
  req: FastifyRequest,
  handle: ReservationHandle | null,
  promptTokens: number,
  completionTokens: number,
): Promise<void> {
  if (!handle) return;
  try {
    const totalTokens = promptTokens + completionTokens;
    const actualUsd = totalTokens * USD_PER_TOKEN_ESTIMATE;
    await handle.release(totalTokens, actualUsd);
  } catch (relErr) {
    req.log.warn({ err: relErr }, "paperclip /release failed (non-fatal)");
  }
}

/**
 * Run the streaming-finish dance. Mirrors the legacy chat.ts finally block
 * with one entry per concern, in the same order, so SSE event ordering is
 * preserved byte-for-byte:
 *   redact-log → persistTurnState → awaiting_user_input → session_end →
 *   finish → root span close → paperclip release → shadow eval → cleanup
 *   skill → reply.raw.end().
 */
export async function finalizeStreamingTurn(
  req: FastifyRequest,
  reply: FastifyReply,
  args: FinalizeStreamingTurnArgs,
): Promise<void> {
  const {
    pool,
    user,
    sessionId,
    ctx,
    messages,
    budget,
    finishReason,
    closed,
    streamRedactions,
    sessionEtag,
    sessionStepsUsed,
    paperclipHandle,
    rootSpan,
    shadowEvaluator,
    agentTraceId,
    cleanupSkillForTurn,
    agentModel,
  } = args;

  // 1. Stream-redaction persistence.
  persistStreamRedactions(req, ctx, streamRedactions);

  // 2. persistTurnState — redact-then-truncate awaiting_question, save row.
  if (sessionId) {
    try {
      const { awaitingQuestion: safeAwaitingQuestion } = await persistTurnState(
        pool,
        user,
        sessionId,
        ctx,
        budget,
        finishReason,
        {
          expectedEtag: sessionEtag,
          messageCount: messages.length,
          priorSessionSteps: sessionStepsUsed,
        },
      );

      // 3. If the model called ask_user, emit awaiting_user_input BEFORE
      //    the final `finish` so clients render the prompt UI.
      if (safeAwaitingQuestion && !closed) {
        try {
          writeEvent(reply, {
            type: "awaiting_user_input",
            session_id: sessionId,
            question: safeAwaitingQuestion,
          });
        } catch {
          // socket already gone
        }
      }
    } catch (saveErr) {
      req.log.warn({ err: saveErr }, "saveSession failed");
    }
  }

  // 4. Phase 4B: session_end fires only on a clean stop. Awaiting-input,
  //    budget-exceeded, and concurrent-modification leave the session open
  //    for the next turn — those are not terminations.
  if (sessionId && finishReason === "stop") {
    try {
      await lifecycle.dispatch("session_end", {
        ctx,
        sessionId,
        finishReason,
      });
    } catch (err) {
      req.log.warn({ err }, "session_end dispatch failed (non-fatal)");
    }
  }

  // 5. Terminal `finish` event.
  if (!closed) {
    try {
      writeEvent(reply, {
        type: "finish",
        finishReason,
        usage: budget?.summary() ?? { promptTokens: 0, completionTokens: 0 },
      });
    } catch {
      // socket already gone
    }
  }

  // 6. Record final LLM usage on the root span and close it.
  try {
    const usageSummary = budget?.summary() ?? { promptTokens: 0, completionTokens: 0 };
    recordLlmUsage(rootSpan, {
      promptTokens: usageSummary.promptTokens,
      completionTokens: usageSummary.completionTokens,
      model: agentModel,
    });
  } catch (spanErr) {
    try { recordSpanError(rootSpan, spanErr); } catch { /* ignore */ }
  }
  try { rootSpan.end(); } catch { /* ignore */ }

  // 7. Paperclip release.
  const usageSummary = budget?.summary() ?? { promptTokens: 0, completionTokens: 0 };
  await releasePaperclipBestEffort(
    req,
    paperclipHandle,
    usageSummary.promptTokens,
    usageSummary.completionTokens,
  );

  // 8. Shadow eval on a clean stop.
  if (shadowEvaluator && finishReason === "stop") {
    void shadowEvaluator
      .evaluateAsync({
        promptName: "agent.system",
        messages,
        traceId: agentTraceId ?? null,
        userEntraId: user,
      })
      .catch((shadowErr: unknown) => {
        req.log.debug({ err: shadowErr }, "shadow eval failed (non-fatal)");
      });
  }

  // 9. Cleanup skill + close socket.
  cleanupSkillForTurn?.();
  try {
    reply.raw.end();
  } catch {
    // already closed
  }
}
