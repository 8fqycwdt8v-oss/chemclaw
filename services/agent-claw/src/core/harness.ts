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

import { BudgetExceededError } from "./budget.js";
import { stepOnce } from "./step.js";
import type { HarnessOptions, HarnessResult, Message, ToolContext } from "./types.js";
import { AwaitingUserInputError } from "../tools/builtins/ask_user.js";

export { type HarnessOptions, type HarnessResult };

/**
 * Run the autonomous ReAct loop.
 *
 * Mutates `options.messages` in-place by appending assistant + tool messages
 * for each step. Callers that need an unmodified copy should clone beforehand.
 */
export async function runHarness(options: HarnessOptions): Promise<HarnessResult> {
  const { messages, tools, llm, budget, lifecycle, ctx, permissions } = options;

  let finalText = "";
  let finishReason = "stop";

  // -------------------------------------------------------------------------
  // pre_turn — fires once before any LLM call this turn.
  // The init-scratch hook initialises ctx.scratchpad.seenFactIds here.
  // -------------------------------------------------------------------------
  await lifecycle.dispatch("pre_turn", { ctx, messages });

  // Wire seenFactIds from scratch into ctx after pre_turn so that tools
  // can access it via the typed accessor. The init-scratch hook must have
  // run first (registered before anti-fabrication).
  const _seenFromScratch = ctx.scratchpad.get("seenFactIds");
  if (_seenFromScratch instanceof Set) {
    ctx.seenFactIds = _seenFromScratch as Set<string>;
  } else if (!ctx.seenFactIds) {
    // Fallback: if init-scratch wasn't registered, initialise here.
    const _fresh = new Set<string>();
    ctx.scratchpad.set("seenFactIds", _fresh);
    ctx.seenFactIds = _fresh;
  }

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

      // One LLM call (+ optional tool execution inside stepOnce).
      const { step, toolOutput, usage } = await stepOnce({
        llm,
        tools,
        messages,
        lifecycle,
        ctx,
        permissions,
      });

      // Record usage — BudgetExceededError propagates out of the loop.
      budget.consumeStep(usage);

      if (step.kind === "text") {
        finalText = step.text;
        // Push the assistant's final text message to history.
        messages.push({ role: "assistant", content: step.text });
        finishReason = "stop";
        break loop;
      }

      // step.kind === "tool_call" — push the tool result to message history.
      // The LLM will see it on the next iteration.
      const toolResultContent =
        toolOutput !== undefined
          ? JSON.stringify(toolOutput)
          : `{"error":"no_output"}`;

      messages.push({
        role: "tool",
        content: toolResultContent,
        toolId: step.toolId,
      });
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
