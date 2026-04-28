// Custom harness while-loop with 5-point hook lifecycle.
// ~150 LOC — kept small by delegating to lifecycle.ts, step.ts, and budget.ts.
//
// Loop pseudocode (from the design doc):
//   fire pre_turn
//   loop:
//     if budget.steps_used >= budget.max_steps: break reason="max_steps"
//     step = stepOnce(...)
//     if step.kind === "text": push assistant msg; break reason="stop"
//     if step.kind === "tool_call":
//       (pre_tool / execute / post_tool happen inside stepOnce)
//       push tool result to messages
//   fire post_turn
//   return { text, finishReason, stepsUsed, usage }

import { BudgetExceededError, estimateTokenCount } from "./budget.js";
import { stepOnce } from "./step.js";
import { syncSeenFactIdsFromScratch } from "./session-state.js";
import type {
  HarnessOptions,
  HarnessResult,
  Message,
  PostCompactPayload,
  PreCompactPayload,
  ToolContext,
} from "./types.js";
import { AwaitingUserInputError } from "../tools/builtins/ask_user.js";

export { type HarnessOptions, type HarnessResult };

/**
 * Run the autonomous ReAct loop.
 *
 * Mutates `options.messages` in-place by appending assistant + tool messages
 * for each step. Callers that need an unmodified copy should clone beforehand.
 */
export async function runHarness(options: HarnessOptions): Promise<HarnessResult> {
  const {
    messages,
    tools,
    llm,
    budget,
    lifecycle,
    ctx,
    streamSink,
    sessionId,
    permissions,
  } = options;

  let finalText = "";
  let finishReason = "stop";

  // Phase 4B: thread the lifecycle onto ctx so tools (e.g. manage_todos)
  // can dispatch fine-grained events (task_created, task_completed). Any
  // pre-existing ctx.lifecycle is preserved — this only fills in the gap
  // for callers that constructed ctx without one.
  if (!ctx.lifecycle) {
    ctx.lifecycle = lifecycle;
  }

  // -------------------------------------------------------------------------
  // onSession — fires once at the very start of a streamed turn, before any
  // hook runs, so the SSE adapter can write the `session` event before the
  // first `text_delta` or `tool_call`. No-op when streamSink is undefined or
  // no sessionId was supplied.
  // -------------------------------------------------------------------------
  if (streamSink && sessionId) {
    streamSink.onSession?.(sessionId);
  }

  // -------------------------------------------------------------------------
  // pre_turn — fires once before any LLM call this turn.
  // The init-scratch hook initialises ctx.scratchpad.seenFactIds here.
  // -------------------------------------------------------------------------
  await lifecycle.dispatch("pre_turn", { ctx, messages });

  // Wire seenFactIds from scratch into ctx after pre_turn so that tools
  // can access it via the typed accessor. The init-scratch hook must have
  // run first (registered before anti-fabrication). Shared with the
  // streaming routes (chat / deep-research) and sub-agent spawner so all
  // four manual-pre_turn sites stay in lockstep.
  syncSeenFactIdsFromScratch(ctx);

  // -------------------------------------------------------------------------
  // Main loop.
  // -------------------------------------------------------------------------
  try {
    loop: while (true) {
      // Step cap check — done BEFORE the LLM call so the cap is exact.
      if (budget.isStepCapReached()) {
        finishReason = "max_steps";
        break loop;
      }

      // One LLM call (+ optional tool execution inside stepOnce). Phase 5:
      // stepOnce returns toolOutputs as an array — single-tool turns get a
      // 1-element array; multi-tool (parallel) turns get N entries.
      const { step, toolOutputs, usage } = await stepOnce({
        llm,
        tools,
        messages,
        lifecycle,
        ctx,
        streamSink,
        permissions,
      });

      // Record usage — BudgetExceededError propagates out of the loop.
      budget.consumeStep(usage);

      // ---------------------------------------------------------------------
      // Mid-turn compaction: when prompt usage crosses the configured
      // threshold (default 60% of maxPromptTokens), dispatch pre_compact /
      // post_compact. The compact-window hook MUTATES payload.messages in
      // place; the harness reads from the same `messages` reference on the
      // next iteration so the LLM sees the compacted window.
      //
      // Token math: pre_tokens / post_tokens are heuristic
      // (estimateTokenCount, ~4 chars/token). The trigger itself is gated
      // on budget.shouldCompact() which uses model-reported usage from
      // consumeStep, so the heuristic only feeds telemetry — not the
      // trigger decision. After compaction we resetPromptTokens() to the
      // post-compact estimate so the next consumeStep doesn't re-trip
      // shouldCompact() on the now-shrunk window.
      // ---------------------------------------------------------------------
      if (budget.shouldCompact()) {
        const preTokens = budget.promptTokens;
        const prePayload: PreCompactPayload = {
          ctx,
          messages,
          trigger: "auto",
          pre_tokens: preTokens,
          custom_instructions: null,
        };
        await lifecycle.dispatch("pre_compact", prePayload);
        const postTokens = estimateTokenCount(messages);
        budget.resetPromptTokens(postTokens);
        const postPayload: PostCompactPayload = {
          ctx,
          trigger: "auto",
          pre_tokens: preTokens,
          post_tokens: postTokens,
        };
        await lifecycle.dispatch("post_compact", postPayload);
      }

      if (step.kind === "text") {
        finalText = step.text;
        // Push the assistant's final text message to history.
        messages.push({ role: "assistant", content: step.text });
        finishReason = "stop";
        break loop;
      }

      // step.kind === "tool_call" or "tool_calls" — push one tool result
      // message per executed tool, in batch order. The LLM sees them all
      // on the next iteration, matching how Claude Code's SDK exposes
      // parallel tool calls.
      for (const { toolId, output } of toolOutputs) {
        const toolResultContent =
          output !== undefined
            ? JSON.stringify(output)
            : `{"error":"no_output"}`;
        messages.push({
          role: "tool",
          content: toolResultContent,
          toolId,
        });
      }
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      finishReason = "budget_exceeded";
      // Re-throw so the caller knows the turn was aborted mid-flight.
      // post_turn still fires in the finally block below.
      throw err;
    }
    if (err instanceof AwaitingUserInputError) {
      // ask_user is a control-flow exception, not an error: the model
      // legitimately asked for clarification. Set finishReason and return
      // normally — post_turn fires in finally to persist the question to
      // session state. Callers (chat.ts, runChainedHarness) check the
      // finishReason and emit the awaiting_user_input SSE event.
      finishReason = "awaiting_user_input";
      // Notify the sink (if any) BEFORE re-throwing so the SSE adapter can
      // emit awaiting_user_input even though this propagates as an error.
      streamSink?.onAwaitingUserInput?.(err.question);
      // Mirror BudgetExceededError's "throw + finally fires" pattern so the
      // SSE streaming path in chat.ts can short-circuit the streaming loop.
      // runChainedHarness explicitly catches this class.
      throw err;
    }
    // Other errors (tool execution failures, hook aborts) propagate as-is.
    throw err;
  } finally {
    // -------------------------------------------------------------------------
    // post_turn — fires even if the loop exited via error.
    // Callers that catch BudgetExceededError will still see this fire.
    // -------------------------------------------------------------------------
    await lifecycle.dispatch("post_turn", {
      ctx,
      finalText,
      stepsUsed: budget.stepsUsed,
    });

    // onFinish — fires after post_turn so any post_turn hook errors don't
    // prevent the sink notification (post_turn errors propagate out before
    // this in current behaviour, so this also fires on the happy path).
    streamSink?.onFinish?.(finishReason, budget.summary());
  }

  return {
    text: finalText,
    finishReason,
    stepsUsed: budget.stepsUsed,
    usage: budget.summary(),
  };
}

// ---------------------------------------------------------------------------
// buildAgent — factory that binds deps so callers get a single callable.
// Useful for constructing a harness once and invoking it multiple times.
// ---------------------------------------------------------------------------
export interface AgentDeps {
  llm: HarnessOptions["llm"];
  tools: HarnessOptions["tools"];
  lifecycle: HarnessOptions["lifecycle"];
  maxSteps: number;
  maxPromptTokens?: number;
  maxCompletionTokens?: number;
}

export interface AgentCallOptions {
  messages: Message[];
  ctx: ToolContext;
}

import { Budget } from "./budget.js";

export function buildAgent(deps: AgentDeps) {
  return {
    /**
     * Run one autonomous turn. A fresh Budget is created per call so caps
     * reset between turns (they don't accumulate across turns).
     */
    run: (callOpts: AgentCallOptions): Promise<HarnessResult> => {
      const budget = new Budget({
        maxSteps: deps.maxSteps,
        maxPromptTokens: deps.maxPromptTokens,
        maxCompletionTokens: deps.maxCompletionTokens,
      });
      return runHarness({
        messages: callOpts.messages,
        tools: deps.tools,
        llm: deps.llm,
        budget,
        lifecycle: deps.lifecycle,
        ctx: callOpts.ctx,
      });
    },
  };
}
