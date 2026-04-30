// Non-streaming chat path (stream:false branch).
//
// Extracted from routes/chat.ts as part of the PR-6 god-file split.
// The non-streaming branch returns a single JSON envelope (text +
// finishReason + usage, or plan_id + steps for plan mode) instead of an
// SSE event stream. It owns its own try/finally lifetime — no
// post_turn dispatch, no session persistence — and shares the
// rootSpan + paperclipHandle teardown with the streaming path's finally
// via the closeTurn helper.
//
// The handler returns the typed result of `reply.send` so the caller
// can do `return void handleNonStreamingTurn(...)` for the early-exit
// pattern that matches the rest of routes/chat.ts.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Span } from "@opentelemetry/api";
import { context as otelContext, trace } from "@opentelemetry/api";
import type { LlmProvider } from "../llm/provider.js";
import type { buildAgent } from "../core/harness.js";

type Agent = ReturnType<typeof buildAgent>;
import {
  recordLlmUsage,
  recordSpanError,
} from "../observability/spans.js";
import {
  USD_PER_TOKEN_ESTIMATE,
  type ReservationHandle,
} from "../core/paperclip-client.js";
import { createPlan, parsePlanSteps, planStore } from "../core/plan-mode.js";
import type { Message, ToolContext } from "../core/types.js";

export interface NonStreamingTurnInput {
  /** Whether the LLM call should produce a plan JSON instead of a normal turn. */
  isPlanMode: boolean;
  /** System prompt assembled by buildSystemPromptForTurn. */
  systemPrompt: string;
  /** Last user message — used as the LLM prompt body in plan mode. */
  lastUserContent: string;
  /** Full conversation window — passed to runHarness in normal mode. */
  messages: Message[];
  ctx: ToolContext;
  agent: Agent;
  llm: LlmProvider;
  user: string;
  model: string;
  rootSpan: Span;
  paperclipHandle: ReservationHandle | null;
  /** Cleanup hook for any turn-scoped skill activation. Called before
   *  every reply.send so a skill-cleanup-failure doesn't get swallowed
   *  by the response flow. */
  cleanupSkillForTurn: (() => void) | undefined;
  signal: AbortSignal;
}

/**
 * Run the non-streaming chat turn end-to-end. Writes the response,
 * releases the Paperclip reservation, and closes the OTel root span on
 * every exit path (success, plan mode, or error → 500).
 */
export async function handleNonStreamingTurn(
  req: FastifyRequest,
  reply: FastifyReply,
  input: NonStreamingTurnInput,
): Promise<void> {
  // Inline closer — encapsulates "record usage on the root span, end the
  // span, release the reservation". Called on every exit.
  const closeTurn = async (promptTokens: number, completionTokens: number): Promise<void> => {
    try {
      recordLlmUsage(input.rootSpan, {
        promptTokens,
        completionTokens,
        model: input.model,
      });
    } catch (spanErr) {
      try { recordSpanError(input.rootSpan, spanErr); } catch { /* ignore */ }
    }
    try { input.rootSpan.end(); } catch { /* ignore */ }

    if (input.paperclipHandle) {
      try {
        const totalTokens = promptTokens + completionTokens;
        const actualUsd = totalTokens * USD_PER_TOKEN_ESTIMATE;
        await input.paperclipHandle.release(totalTokens, actualUsd);
      } catch (relErr) {
        req.log.warn({ err: relErr }, "paperclip /release failed (non-fatal)");
      }
    }
  };

  try {
    if (input.isPlanMode) {
      // Plan mode: ask LLM to produce a JSON plan; no tool execution.
      // Run the completeJson call inside the rootSpan's OTel context so
      // LiteLLM's auto-instrumentation parents its trace under the
      // root and inherits the prompt:agent.system tag.
      const planJson = await otelContext.with(
        trace.setSpan(otelContext.active(), input.rootSpan),
        () =>
          input.llm.completeJson({
            system: input.systemPrompt,
            user: input.lastUserContent,
            signal: input.signal,
          }),
      );
      const steps = parsePlanSteps(planJson);
      const plan = createPlan(steps, input.messages, input.user);
      planStore.save(plan);
      input.cleanupSkillForTurn?.();
      await closeTurn(0, 0);
      await reply.send({
        plan_id: plan.plan_id,
        steps: plan.steps,
        created_at: plan.created_at,
      });
      return;
    }
    const result = await otelContext.with(
      trace.setSpan(otelContext.active(), input.rootSpan),
      () => input.agent.run({ messages: input.messages, ctx: input.ctx, signal: input.signal }),
    );
    input.cleanupSkillForTurn?.();
    await closeTurn(result.usage.promptTokens, result.usage.completionTokens);
    await reply.send({
      text: result.text,
      finishReason: result.finishReason,
      usage: result.usage,
    });
  } catch (err) {
    req.log.error({ err }, "chat generate failed");
    input.cleanupSkillForTurn?.();
    try { recordSpanError(input.rootSpan, err); } catch { /* ignore */ }
    await closeTurn(0, 0);
    await reply.code(500).send({ error: "internal" });
  }
}
